import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { google } from 'googleapis';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

export class DriveClient {
  constructor(config) {
    this.config = config;
    this.drive = null;
  }

  async connect() {
    const driveConfig = this.config.drive;
    if (!driveConfig.enabled) throw new Error('Google Drive is disabled');
    let auth;
    if (driveConfig.serviceAccountFile) {
      auth = new google.auth.GoogleAuth({ keyFile: driveConfig.serviceAccountFile, scopes: [DRIVE_SCOPE] });
    } else if (driveConfig.oauthClientFile && driveConfig.oauthRefreshToken) {
      const payload = JSON.parse(await fsp.readFile(driveConfig.oauthClientFile, 'utf8'));
      const credentials = payload.installed ?? payload.web;
      auth = new google.auth.OAuth2(credentials.client_id, credentials.client_secret, credentials.redirect_uris?.[0]);
      auth.setCredentials({ refresh_token: driveConfig.oauthRefreshToken });
    } else {
      throw new Error('Missing Drive service account or OAuth credentials');
    }
    this.drive = google.drive({ version: 'v3', auth });
    await this.drive.files.get({ fileId: driveConfig.rootFolderId, fields: 'id,name', supportsAllDrives: true });
    return true;
  }

  static async authorize(oauthClientFile, openExternal) {
    if (!oauthClientFile) throw new Error('Chưa chọn file OAuth client JSON');
    const payload = JSON.parse(await fsp.readFile(oauthClientFile, 'utf8'));
    const credentials = payload.installed ?? payload.web;
    if (!credentials?.client_id || !credentials?.client_secret) throw new Error('OAuth client JSON không hợp lệ');
    const redirectUri = 'http://127.0.0.1:53682/oauth2callback';
    const client = new google.auth.OAuth2(credentials.client_id, credentials.client_secret, redirectUri);
    const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [DRIVE_SCOPE] });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { server.close(); reject(new Error('Hết thời gian đăng nhập Google')); }, 180000);
      const server = http.createServer((request, response) => {
        const incoming = new URL(request.url, redirectUri);
        if (incoming.pathname !== '/oauth2callback') return;
        const error = incoming.searchParams.get('error');
        const value = incoming.searchParams.get('code');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(error ? '<h2>Không thể kết nối Google Drive.</h2>' : '<h2>Đã kết nối Google Drive. Bạn có thể đóng cửa sổ này.</h2>');
        clearTimeout(timer); server.close();
        if (error || !value) reject(new Error(error || 'Google không trả về authorization code')); else resolve(value);
      });
      server.on('error', reject);
      server.listen(53682, '127.0.0.1', () => openExternal(url));
    });
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) throw new Error('Google không trả về refresh token');
    return tokens.refresh_token;
  }

  async ensure() {
    if (!this.drive) await this.connect();
    return this.drive;
  }

  async createSessionFolder(session) {
    const drive = await this.ensure();
    if (!this.config.drive.rootFolderId) throw new Error('Missing Google Drive root folder ID');
    const existing = await drive.files.list({
      q: `'${this.config.drive.rootFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false and appProperties has { key='photoboothSession' and value='${session.id}' }`,
      fields: 'files(id,name,webViewLink)', supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 1
    });
    if (existing.data.files?.[0]) {
      const folder = existing.data.files[0];
      folder.publicPermissionId = await this.findPublicPermission(folder.id);
      return folder;
    }
    const response = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: session.id,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [this.config.drive.rootFolderId],
        description: `Photobooth session ${session.createdAt}`,
        appProperties: { photoboothSession: session.id, timestamp: session.createdAt }
      },
      fields: 'id,name,webViewLink'
    });
    let publicPermissionId = null;
    if (this.config.drive.makeSessionPublic) {
      const permission = await drive.permissions.create({
        fileId: response.data.id, supportsAllDrives: true,
        requestBody: { role: 'reader', type: 'anyone', allowFileDiscovery: false }, fields: 'id'
      });
      publicPermissionId = permission.data.id;
    }
    const metadata = await drive.files.get({ fileId: response.data.id, fields: 'id,webViewLink', supportsAllDrives: true });
    return { ...metadata.data, publicPermissionId };
  }

  async findPublicPermission(folderId) {
    const drive = await this.ensure();
    const response = await drive.permissions.list({ fileId: folderId, supportsAllDrives: true, fields: 'permissions(id,type,role)' });
    return response.data.permissions?.find((permission) => permission.type === 'anyone')?.id ?? null;
  }

  async revokePermission(folderId, permissionId) {
    const drive = await this.ensure();
    await drive.permissions.delete({ fileId: folderId, permissionId, supportsAllDrives: true });
  }

  async uploadFile(folderId, item) {
    const drive = await this.ensure();
    const mimeByExtension = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4'
    };
    const existing = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and appProperties has { key='photoboothItem' and value='${item.id}' }`,
      fields: 'files(id,name,md5Checksum,webViewLink,size)', supportsAllDrives: true, includeItemsFromAllDrives: true, pageSize: 1
    });
    if (existing.data.files?.[0]?.md5Checksum?.toLowerCase() === item.md5.toLowerCase()) return existing.data.files[0];
    const request = {
      supportsAllDrives: true,
      requestBody: {
        name: item.filename,
        appProperties: { photoboothItem: item.id, timestamp: item.createdAt, kind: item.kind }
      },
      media: { mimeType: mimeByExtension[path.extname(item.filename).toLowerCase()] ?? 'application/octet-stream', body: fs.createReadStream(item.path) },
      fields: 'id,name,md5Checksum,webViewLink,size'
    };
    let response;
    if (existing.data.files?.[0]) {
      response = await drive.files.update({ ...request, fileId: existing.data.files[0].id });
    } else {
      request.requestBody.parents = [folderId];
      response = await drive.files.create(request);
    }
    return response.data;
  }

  async listFrameFiles(folderId) {
    const drive = await this.ensure();
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`, spaces: 'drive',
      fields: 'files(id,name,mimeType,modifiedTime,md5Checksum)', supportsAllDrives: true,
      includeItemsFromAllDrives: true, pageSize: 1000
    });
    return response.data.files ?? [];
  }

  async download(fileId, target) {
    const drive = await this.ensure();
    const response = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    await fsp.writeFile(target, Buffer.from(response.data));
  }
}
