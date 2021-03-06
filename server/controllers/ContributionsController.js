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

const path = require('path');
const https = require('https');
const multer = require('multer');
const fsPromises = require('fs').promises;
const querystring = require('querystring');
const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const Logger = require('../lib/Logger.js');
const CustomError = require('../lib/CustomError.js');
const Notifications = require('../services/Notifications.js');

// 50 MB
const MAX_FILE_SIZE = 1024 * 1024 * 50;
const ASSET_TYPES = [
  'siir',
  'oyku',
  'deneme',
  'roportaj',
  'elestiri',
  'resim',
  'ses',
  'video',
];

class ContributionsController {
  constructor(params) {
    this.settings = params.settings;
    this.databasePool = params.databasePool;
    this.uploadsDir = params.uploadsDir;

    this.init();
  }

  init() {
    this.router = new Router();

    this.initMulter();

    this.onPostContribution = this.onPostContribution.bind(this);
    this.uploadMiddleware = this.uploadMiddleware.bind(this);
    this.initRoutes();
  }

  initMulter() {
    this.multerStorage = multer.diskStorage({
      destination: async (req, file, cb) => {
        try {
          const stat = await fsPromises.stat(this.uploadsDir);

          if (!stat.isDirectory()) {
            throw new Error('`uploads` must be a directory.');
          }

          cb(null, this.uploadsDir);
        } catch (ex) {
          // If this.uploadsDir doesn't exist then create it
          if (ex.code === 'ENOENT') {
            try {
              await fsPromises.mkdir(this.uploadsDir);
              cb(null, this.uploadsDir);
            } catch (err) {
              cb(err);
            }

            return;
          }

          cb(ex);
        }
      },
      filename: function fileNameFunction(req, file, cb) {
        setImmediate(() => {
          const fileExtension = path.extname(file.originalname);
          cb(null, `${uuidv4()}${fileExtension}`);
        });
      },
    });

    this.multer = multer({
      storage: this.multerStorage,
      limits: {
        fileSize: MAX_FILE_SIZE,
        files: 1,
      },
    });

    this.multerMiddleware = this.multer.single('file');
  }

  uploadMiddleware(req, res, next) {
    this.multerMiddleware(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        switch (err.code) {
          case 'LIMIT_FILE_SIZE': {
            res.json({
              success: false,
              error: 'Dosya çok büyük.',
            });
            return;
          }

          default:
            break;
        }
      }

      next(err);
    });
  }

  initRoutes() {
    this.router.post('/katkida-bulunun', this.uploadMiddleware, this.onPostContribution);
  }

  getRouter() {
    return this.router;
  }

  validateFormInputs(req) { // eslint-disable-line class-methods-use-this
    if (!req.body.name) {
      throw new CustomError('İsim bilgisi eksik; lütfen isminizi giriniz.');
    }

    if (req.body.name.length > 40) {
      throw new CustomError('İsim çok uzun, lütfen isminizi 40 karakteri aşmayacak şekilde kısaltın.');
    }

    if (!req.body.email) {
      throw new CustomError('Eposta bilgisi eksik; lütfen epostanızı giriniz.');
    }

    if (req.body.email.length > 100) {
      throw new CustomError('Eposta çok uzun, lütfen 100 karakterden kısa bir eposta giriniz.');
    }

    if (!req.body.email.includes('@') || req.body.email.indexOf('@') !== req.body.email.lastIndexOf('@')) {
      throw new CustomError('Lütfen geçerli bir eposta adresi giriniz.');
    }

    if (!req.body.title) {
      throw new CustomError('Başlık bilgisi eksik; lütfen başlık giriniz.');
    }

    if (req.body.title.length > 120) {
      throw new CustomError('Başlık çok uzun, lütfen 120 karakterden kısa bir başlık giriniz.');
    }

    if (!ASSET_TYPES.includes(req.body.assetType)) {
      throw new CustomError('Eser Türü eksik, lütfen Eser Türünü seçiniz.');
    }

    if (req.body.assetType === 'video') {
      if (!req.body.videoLink) {
        throw new CustomError('Video linki eksik; lütfen video linkini giriniz.');
      }

      if (req.body.videoLink.length > 255) {
        throw new CustomError('Video linki çok uzun, lütfen daha kısa bir adres girin.');
      }
    }

    if (req.body.message && req.body.message.length > 5000) {
      throw new CustomError('Mesaj çok uzun, lütfen daha kısa bir mesaj girin.');
    }

    if (!req.body['g-recaptcha-response']) {
      throw new CustomError('Güvenlik doğrulaması hatası. Lütfen sayfayı yenileyip tekrar deneyiniz.');
    }
  }

  postCaptchaResponse(req) {
    return new Promise((resolve, reject) => {
      const url = new URL('/recaptcha/api/siteverify', 'https://www.google.com/');
      const postData = querystring.stringify({
        secret: this.settings.recaptchaSecret,
        response: req.body['g-recaptcha-response'],
      });

      const requestOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const request = https.request(url, requestOptions, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error('Recaptcha validation request failed.'));
          return;
        }

        response.setEncoding('utf8');
        response.on('error', reject);

        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (ex) {
            reject(ex);
          }
        });
      });

      request.on('error', reject);
      request.write(postData);
      request.end();
    });
  }

  async verifyCaptcha(req) {
    const response = await this.postCaptchaResponse(req);

    if (!response.success) {
      throw new CustomError('Güvenlik doğrulaması hatası. Lütfen sayfayı yenileyip tekrar deneyiniz.');
    }
  }

  async onPostContribution(req, res) {
    let conn;

    try {
      this.validateFormInputs(req);

      conn = await this.databasePool.getConnection();
      const fileName = req.file ? req.file.filename : null;

      const result = await conn.query(`
        INSERT INTO assets (contributor, contributorEmail, title, type, video, message, filename) 
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.body.name,
        req.body.email,
        req.body.title,
        req.body.assetType,
        req.body.videoLink || null,
        req.body.message,
        fileName,
      ]);

      if (result.affectedRows !== 1) {
        throw new Error('Failed to insert asset entry into the database.');
      }

      // A contributon without an asset has been made. Add a notification to the queue
      if (fileName === null) {
        await Notifications.addContributionNotification(conn, this.settings.assetRecipient, {
          contributor: req.body.name,
          contributorEmail: req.body.email,
          title: req.body.title,
          type: req.body.assetType,
          video: req.body.videoLink || null,
          message: req.body.message,
        });
      }

      res.json({ success: true });
    } catch (ex) {
      if (ex instanceof CustomError) {
        res.json({
          success: false,
          error: ex.message,
        });
        return;
      }

      Logger.trace(ex);

      res.json({
        success: false,
        error: 'Sunucuda bir hata oluştu. Lütfen sayfayı yenileyip tekrar deneyiniz.',
      });
    } finally {
      if (conn) {
        conn.release();
      }
    }
  }
}

module.exports = ContributionsController;
