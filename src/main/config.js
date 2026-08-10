import fs from 'node:fs/promises';
import path from 'node:path';

function parseEnvValue(raw) {
  let quote = '';
  let value = '';
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? '' : character;
      value += character;
      continue;
    }
    if (character === '#' && !quote && (index === 0 || /\s/.test(raw[index - 1]))) break;
    value += character;
  }
  value = value.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  return value;
}

export function parseEnv(text) {
  const values = {};
  for (const sourceLine of String(text).split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    values[line.slice(0, separator).trim()] = parseEnvValue(line.slice(separator + 1));
  }
  return values;
}

const envBoolean = (value, fallback) => value == null ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
const envNumber = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function envConfigPatch(values, appPath) {
  const resolution = Math.max(1200, Math.min(7200, Math.round(envNumber(values.COMPOSITE_TARGET_RESOLUTION, 1800))));
  const port = Math.max(1024, Math.min(65535, Math.round(envNumber(values.PORT, 3847))));
  const framesValue = values.LOCAL_FRAMES_DIR || './frames';
  const videoTimeFactor = Math.max(.125, Math.min(1, envNumber(values.VIDEO_SPEED, .5)));
  return {
    camera: {
      mirrorPreview: envBoolean(values.MIRROR_PREVIEW, true),
      mirrorOutput: envBoolean(values.MIRROR_OUTPUT, false)
    },
    gallery: { port },
    frames: { localDir: path.resolve(appPath, framesValue) },
    branding: {
      name: values.BRANDING_NAME || 'Roti Photobooth',
      tagline: values.BRANDING_TAGLINE || 'Giữ lại khoảnh khắc của bạn'
    },
    print: {
      deviceName: values.PRINTER_NAME || '',
      deviceName2Cut: values.PRINTER_NAME_2CUT || '',
      offsetX: envNumber(values.PRINT_OFFSET_X, 0),
      offsetY: envNumber(values.PRINT_OFFSET_Y, 0),
      offset4x6X: envNumber(values.PRINT_4X6_OFFSET_X, 0),
      offset4x6Y: envNumber(values.PRINT_4X6_OFFSET_Y, 0),
      offset4x6LandscapeX: envNumber(values.PRINT_4X6_LANDSCAPE_OFFSET_X, 0),
      offset4x6LandscapeY: envNumber(values.PRINT_4X6_LANDSCAPE_OFFSET_Y, 0)
    },
    composite: {
      targetResolution: resolution,
      jpegQuality: Math.max(1, Math.min(100, Math.round(envNumber(values.COMPOSITE_JPEG_QUALITY, 95)))),
      chroma444: envBoolean(values.COMPOSITE_CHROMA_444, false),
      qrEnabled: envBoolean(values.ENABLE_QR_ON_FRAME, true),
      qrSizeStrip: Math.max(60, Math.round(envNumber(values.QR_SIZE_STRIP, 140))),
      qrSizeStandard: Math.max(60, Math.round(envNumber(values.QR_SIZE_STANDARD, 120))),
      qrPosXFraction: Math.max(0, Math.min(1, envNumber(values.QR_POS_X_FRACTION, .79))),
      qrPosYFraction: Math.max(0, Math.min(1, envNumber(values.QR_POS_Y_FRACTION, .975)))
    },
    timelapse: {
      enabled: envBoolean(values.TIMELAPSE_ENABLED, true),
      speed: Math.round((1 / videoTimeFactor) * 100) / 100,
      crf: Math.max(0, Math.min(51, Math.round(envNumber(values.VIDEO_CRF, 28)))),
      videoBitsPerSecond: Math.max(500000, Math.min(20000000, Math.round(envNumber(values.TIMELAPSE_VIDEO_BITS_PER_SECOND, 4000000))))
    },
    legacy: {
      cmsApiUrl: values.CMS_API_URL || '',
      comPort: values.COM_PORT || '',
      skinSmoothingLevel: envNumber(values.SKIN_SMOOTHING_LEVEL, 0),
      videoSpeed: videoTimeFactor,
      videoCrf: envNumber(values.VIDEO_CRF, 5)
    }
  };
}

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(base?.[key] ?? {}, value)
      : value;
  }
  return result;
}

export class ConfigStore {
  constructor(appPath, userDataPath, secretCodec = null) {
    this.defaultPath = path.join(appPath, 'config', 'default.json');
    this.userPath = path.join(userDataPath, 'config.json');
    this.secretCodec = secretCodec;
    this.value = {};
  }

  async load() {
    const defaults = JSON.parse(await fs.readFile(this.defaultPath, 'utf8'));
    let envValues = {};
    try { envValues = parseEnv(await fs.readFile(path.join(path.dirname(this.defaultPath), '..', '.env'), 'utf8')); } catch {}
    let user = {};
    try { user = JSON.parse(await fs.readFile(this.userPath, 'utf8')); } catch {}
    if (user.drive?.oauthRefreshTokenEncrypted && this.secretCodec) {
      try { user.drive.oauthRefreshToken = this.secretCodec.decrypt(user.drive.oauthRefreshTokenEncrypted); } catch {}
    }
    this.value = merge(merge(defaults, user), envConfigPatch(envValues, path.dirname(path.dirname(this.defaultPath))));
    return this.value;
  }

  get() { return structuredClone(this.value); }

  async save(next) {
    this.value = merge(this.value, next);
    await fs.mkdir(path.dirname(this.userPath), { recursive: true });
    const temporary = `${this.userPath}.tmp`;
    const diskValue = structuredClone(this.value);
    if (diskValue.drive?.oauthRefreshToken && this.secretCodec) {
      diskValue.drive.oauthRefreshTokenEncrypted = this.secretCodec.encrypt(diskValue.drive.oauthRefreshToken);
      delete diskValue.drive.oauthRefreshToken;
    }
    await fs.writeFile(temporary, JSON.stringify(diskValue, null, 2), 'utf8');
    await fs.rename(temporary, this.userPath);
    return this.get();
  }
}
