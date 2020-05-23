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
const { Router } = require('express');

class MagazinesController {
  constructor(params) {
    this.databasePool = params.databasePool;
    this.staticPath = params.staticPath;

    this.cache = {
      lastModifiedDate: null,
      fileContent: null,
    };

    this.indexPath = path.join(this.staticPath, 'index.html');
    this.init();
  }

  init() {
    this.router = Router();

    // return list of the magazines
    this.router.get('/magazines', (...args) => this.getMagazines(...args));

    // return HTML content of each page
    this.router.get('/magazines/:magazineIndex/pages', (...args) => this.getMagazine(...args));

    // DEV MODE: Serve audio files (nginx will perform this on the server)
    this.router.get('/magazines/:magazineIndex/audio/:audioFile', (req, res) => this.serveAudioFiles(req, res));

    // DEV MODE: Serve individual magazine URLs (nginx will perform this on the server)
    this.router.get(/^\/dergiler\/sayi\d+(?:\/\d+)?/, (...args) => this.serveIndex(...args));
  }

  getRouter() {
    return this.router;
  }

  async serveIndex(_, res) {
    try {
      const stat = await fs.promises.stat(this.indexPath);

      if (stat.mtime !== this.cache.lastModifiedDate) {
        this.cache.fileContent = await fs.promises.readFile(this.indexPath, 'utf8');
        this.cache.lastModifiedDate = stat.mtime;
      }

      res.set('content-type', 'text/html; charset=UTF-8');
      res.end(this.cache.fileContent);
    } catch (ex) {
      console.trace(ex);
      res.status(500).end('<h1>Internal Server Error</h1>');
    }
  }

  serveAudioFiles(req, res) {
    const { magazineIndex, audioFile } = req.params;
    console.log('Serving audio file', path.join(this.staticPath, 'audio', magazineIndex, audioFile));
    res.sendFile(path.join(this.staticPath, 'audio', magazineIndex, audioFile));
  }

  async getMagazines(req, res) {
    let conn;

    try {
      conn = await this.databasePool.getConnection();
      const rows = await conn.query('SELECT id, publishDateText, thumbnailURL, '
        + 'tableOfContents FROM magazines WHERE visible = 1 AND publishDate < CURRENT_TIMESTAMP()');
      const result = {
        success: true,
        magazines: [],
      };

      for (const row of rows) {
        const {
          id, publishDateText, thumbnailURL, tableOfContents,
        } = row;
        result.magazines.push({
          index: +id,
          publishDateText,
          thumbnailURL,
          tableOfContents,
        });
      }

      res.status(200).json(result);
    } catch (ex) {
      console.trace(ex);
      res.status(200).json({
        success: false,
        error: 'Someting went wrong.',
      });
    } finally {
      if (conn) conn.release();
    }
  }

  async getMagazine(req, res) {
    let conn;
    const { magazineIndex } = req.params;

    try {
      conn = await this.databasePool.getConnection();
      const rows = await conn.query('SELECT `content`, pageNumber FROM pages '
        + 'WHERE magazineIndex = ? AND magazineIndex = (SELECT id FROM magazines '
        + 'WHERE visible = 1 AND publishDate < CURRENT_TIMESTAMP() AND id = ?)', [
        +magazineIndex,
        +magazineIndex,
      ]);
      const result = {
        success: true,
        pages: {},
      };

      for (const row of rows) {
        result.pages[row.pageNumber] = row.content;
      }

      res.status(200).json(result);
    } catch (ex) {
      console.trace(ex);
      res.status(200).json({
        success: false,
        error: 'Someting went wrong.',
      });
    } finally {
      if (conn) conn.release();
    }
  }
}

module.exports = MagazinesController;