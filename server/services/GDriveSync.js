// Copyright 2020 Mehmet Baker
//
// This file is part of galata-dergisi.
//
// galata-dergisi is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// galata-dergisi is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with galata-dergisi. If not, see <https://www.gnu.org/licenses/>.

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const Utils = require('../lib/Utils.js');
const Logger = require('../lib/Logger.js');
const Notifications = require('./Notifications.js');

const fsPromises = fs.promises;

// 1 minute
const SYNC_INTERVAL = 60 * 1000;
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

class GDriveSync {
  constructor(params) {
    this.databasePool = params.databasePool;
    this.uploadsDir = params.uploadsDir;
  }

  static init(params) {
    const gdriveSync = new GDriveSync(params);
    gdriveSync.start();
  }

  async start() {
    try {
      await this.initOAuthClient();
      this.initDrive();
      this.syncLoop();
    } catch (ex) {
      Logger.trace(ex);
      Logger.error('Failed to initialize Google Drive Sync.');
      process.exit(13);
    }
  }

  async initOAuthClient() {
    let conn;

    try {
      conn = await this.databasePool.getConnection();
      const {
        driveClientId, driveClientSecret, driveRedirectURI, driveRefreshToken,
      } = await Utils.getSettings(conn);
      this.oAuth2Client = new google.auth.OAuth2(driveClientId, driveClientSecret, driveRedirectURI);
      this.oAuth2Client.setCredentials({ refresh_token: driveRefreshToken });

      // Add a listener for refresh tokens
      this.oAuth2Client.on('tokens', async (tokens) => {
        if (tokens.refresh_token) {
          Logger.info('Received new refresh token.');
          this.saveRefreshToken(tokens.refresh_token);
        }
      });
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }

  async saveRefreshToken(refreshToken) {
    let conn;

    try {
      conn = await this.databasePool.getConnection();
      const result = await conn.query('UPDATE settings SET driveRefreshToken = ?', [refreshToken]);

      if (result.affectedRows !== 1) {
        Logger.warn('Falied to save refresh token in the database!');
        return;
      }

      Logger.info('Refresh token has been saved.');
    } catch (ex) {
      Logger.trace(ex);
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }

  initDrive() {
    this.drive = google.drive({
      version: 'v3',
      auth: this.oAuth2Client,
    });
  }

  async syncLoop() {
    try {
      const assets = await this.getAssets();

      for (const asset of assets) {
        asset.filepath = path.join(this.uploadsDir, asset.filename);

        if (await this.fileExists(asset)) {
          await this.uploadAsset(asset);

          Logger.log('Saving Google Drive information to database...');
          await this.saveDriveDataToDatabase(asset);

          Logger.log('Qeueing a notification for the new asset...');
          await this.sendContributionNotification(asset.id);
        }
      }
    } catch (ex) {
      Logger.trace(ex);
    } finally {
      setTimeout(() => this.syncLoop(), SYNC_INTERVAL);
    }
  }

  async getAssets() {
    let conn;

    try {
      conn = await this.databasePool.getConnection();

      Logger.log('Querying database for new assets...');
      const rows = await conn.query('SELECT * FROM assets WHERE isUploaded = 0 AND fileName IS NOT NULL');
      Logger.log(Utils.constructEnglishCountingSentence(rows.length, 'asset'));

      return rows;
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }

  async fileExists(asset) {
    try {
      const stat = await fsPromises.stat(asset.filepath);

      if (stat.isFile()) {
        return true;
      }

      Logger.warn(`${asset.filename} is not a file!`);
    } catch (ex) {
      if (ex.code === 'ENOENT') {
        this.sendErrorNotification({
          title: "File doesn't exist on the server",
          error: ex,
          message: `Asset Id: ${asset.id}`,
        });

        return false;
      }

      this.sendErrorNotification({
        title: 'File System Error!!!',
        error: ex,
      });
    }

    return false;
  }

  async ensureFolderInDrive(rootFolderId, folderName) {
    Logger.log(`Querying Google Drive to check if "${folderName}" exists...`);

    const { data: { files }} = await this.drive.files.list({
      q: `mimeType = '${FOLDER_MIME_TYPE}' and '${rootFolderId}' in parents and name = '${folderName}'`,
      pageSize: 1,
      fields: 'nextPageToken, files(id, name)',
    });

    if (files.length === 1) {
      const [{ id }] = files;
      Logger.log(`Found "${folderName}" in Google Drive. Returning its ID: ${id}`);
      return id;
    }

    Logger.log(`"${folderName}" doesn't exist. Creating it...`);

    const { data: file } = await this.drive.files.create({
      resource: {
        name: folderName,
        mimeType: FOLDER_MIME_TYPE,
        parents: [rootFolderId],
      },
      fields: 'id',
    });

    Logger.log(`"${folderName}" has been created. Returning its ID: ${file.id}`);

    return file.id;
  }

  async getDriveFolderId() {
    let conn;

    try {
      conn = await this.databasePool.getConnection();
      const { driveRootFolder } = await Utils.getSettings(conn);
      const date = new Date();

      const yearFolderId = await this.ensureFolderInDrive(driveRootFolder, date.getFullYear());
      const monthFolderId = await this.ensureFolderInDrive(yearFolderId, Utils.getLocalMonth(date));
      return monthFolderId;
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }

  async uploadAsset(asset) {
    try {
      Logger.log(`Uploading asset #${asset.id}: ${asset.filename}`);

      const fileName = `${asset.title} - ${asset.contributor}${path.extname(asset.filename)}`;

      const driveFolderId = await this.getDriveFolderId();
      const res = await this.drive.files.create({
        fields: 'id, webViewLink',
        requestBody: {
          name: fileName,
          parents: [driveFolderId],
          properties: {
            assetId: asset.id,
            contributor: asset.contributor,
            contributorEmail: asset.contributorEmail,
            title: asset.title,
            type: asset.type,
            video: asset.video,
            filename: asset.filename,
          },
        },
        media: {
          body: fs.createReadStream(asset.filepath),
        },
      });

      Logger.log(`Asset #${asset.id} is uploaded.`);
      Logger.log('--------------------------------------------');
      Logger.log('File ID  : ', res.data.id);
      Logger.log('Asset ID : ', asset.id);
      Logger.log('File Name: ', fileName);
      Logger.log('Web Link : ', res.data.webViewLink);
      Logger.log('--------------------------------------------');

      asset.googleDriveData = res.data;
    } catch (ex) {
      if (ex && ex.response && ex.response.data && ex.response.data.error_description) {
        const { error, error_description: errorDescription } = ex.response.data;
        this.sendErrorNotification({
          title: 'Google Drive Upload Failed!',
          error: ex,
          message: `Error: ${error} <br />Description: ${errorDescription}`,
        });

        throw ex;
      }

      this.sendErrorNotification({
        title: 'Google Drive Upload Failed!',
        error: ex,
      });

      throw ex;
    }
  }

  async saveDriveDataToDatabase(asset) {
    let conn;

    try {
      conn = await this.databasePool.getConnection();

      const updateResult = await conn.query('UPDATE assets SET driveId = ?, isUploaded = 1, driveLink = ? WHERE id = ?', [
        asset.googleDriveData.id,
        asset.googleDriveData.webViewLink,
        asset.id,
      ]);

      if (updateResult.affectedRows !== 1) {
        throw new Error(`Failed to update asset #${asset.id}'s entry in database.`);
      }

      Logger.log(`Asset #${asset.id}'s file id is saved to database.`);
    } catch (error) {
      this.sendErrorNotification({
        title: 'Failed to Save Google Drive Data to Database!',
        error,
      });

      throw error;
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }

  async sendErrorNotification(data) {
    let conn;

    try {
      conn = await this.databasePool.getConnection();
      const { adminRecipient } = await Utils.getSettings(conn);
      await Notifications.addErrorNotification(conn, adminRecipient, data);
    } catch (ex) {
      Logger.trace(ex);
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }

  async sendContributionNotification(assetId) {
    let conn;

    try {
      conn = await this.databasePool.getConnection();
      const rows = await conn.query('SELECT * FROM assets WHERE id = ?', [assetId]);

      if (rows.length === 1) {
        const [asset] = rows;
        const { assetRecipient } = await Utils.getSettings(conn);
        await Notifications.addContributionNotification(conn, assetRecipient, asset);
        Logger.log('Notification is queued.');
      }
    } catch (error) {
      this.sendErrorNotification({
        title: 'Failed to Add Contribution Notification to the Queue',
        error,
      });

      throw error;
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }
}

module.exports = GDriveSync;
