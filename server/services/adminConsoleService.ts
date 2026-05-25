import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

interface AdminAuthState {
  username: string;
  passwordHash: string;
  passwordSalt: string;
  updatedAt: string;
}

interface AdminTokenSession {
  username: string;
  createdAt: string;
}

export interface EditableAdminSetting {
  key: string;
  category: 'runtime' | 'integration' | 'deployment';
  label: string;
  description: string;
  inputType: 'text' | 'number' | 'boolean' | 'select';
  requiresRestart: boolean;
  options?: Array<{
    label: string;
    value: string;
  }>;
}

const authFilePath = path.resolve(process.cwd(), 'data/admin-auth.json');
const envFilePath = path.resolve(process.cwd(), '.env');
const tokenStore = new Map<string, AdminTokenSession>();

const editableSettings: EditableAdminSetting[] = [
  {
    key: 'OPENAI_MODEL',
    category: 'integration',
    label: 'AI 모델',
    description: '전략 분석에 사용하는 OpenAI 모델',
    inputType: 'text',
    requiresRestart: true
  },
  {
    key: 'MARKET_DATA_PROVIDER',
    category: 'integration',
    label: '시세 공급자',
    description: '실시간 시세 공급자 식별자',
    inputType: 'select',
    requiresRestart: true,
    options: [
      { label: 'binance', value: 'binance' },
      { label: 'mock', value: 'mock' }
    ]
  },
  {
    key: 'ENABLE_REAL_MARKET_DATA',
    category: 'integration',
    label: '실시간 시세 사용',
    description: '실시간 공급자를 사용할지 여부',
    inputType: 'boolean',
    requiresRestart: true
  },
  {
    key: 'ENABLE_DEX_EXECUTION',
    category: 'deployment',
    label: 'DEX 실행 사용',
    description: '서버 DEX 경로 활성화',
    inputType: 'boolean',
    requiresRestart: true
  },
  {
    key: 'ENABLE_HYPERLIQUID_TESTNET_EXECUTION',
    category: 'deployment',
    label: 'Hyperliquid 실행 사용',
    description: '서버 Hyperliquid 경로 활성화',
    inputType: 'boolean',
    requiresRestart: true
  },
  {
    key: 'ENABLE_ONCHAIN_PROOF',
    category: 'deployment',
    label: '온체인 증빙 사용',
    description: '실행 증빙 기록 활성화',
    inputType: 'boolean',
    requiresRestart: true
  },
  {
    key: 'MARKET_STREAM_INTERVAL_MS',
    category: 'runtime',
    label: '시세 스트림 주기(ms)',
    description: '시장 스트림 갱신 간격',
    inputType: 'number',
    requiresRestart: true
  },
  {
    key: 'ADMIN_PATH',
    category: 'runtime',
    label: '관리자 경로',
    description: '관리자 API 접근 경로. 프론트의 VITE_ADMIN_PATH와 함께 맞춰야 합니다.',
    inputType: 'text',
    requiresRestart: true
  },
  {
    key: 'VITE_ADMIN_PATH',
    category: 'runtime',
    label: '프론트 관리자 경로',
    description: '브라우저에서 접근하는 관리자 경로',
    inputType: 'text',
    requiresRestart: true
  }
];

function derivePasswordHash(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString('hex');
}

function ensureAuthFile() {
  fs.mkdirSync(path.dirname(authFilePath), { recursive: true });
  if (fs.existsSync(authFilePath)) {
    return;
  }

  const salt = randomBytes(16).toString('hex');
  const initialState: AdminAuthState = {
    username: 'admin',
    passwordSalt: salt,
    passwordHash: derivePasswordHash('admin', salt),
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(authFilePath, JSON.stringify(initialState, null, 2));
}

function readAuthState(): AdminAuthState {
  ensureAuthFile();
  return JSON.parse(fs.readFileSync(authFilePath, 'utf8')) as AdminAuthState;
}

function writeAuthState(state: AdminAuthState) {
  fs.writeFileSync(authFilePath, JSON.stringify(state, null, 2));
}

function normalizeBooleanValue(value: string) {
  return value === 'true' ? 'true' : 'false';
}

function readEnvLines() {
  if (!fs.existsSync(envFilePath)) {
    return [] as string[];
  }

  return fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/);
}

function writeEnvLines(lines: string[]) {
  fs.writeFileSync(envFilePath, `${lines.join('\n').replace(/\n+$/, '')}\n`);
}

function normalizeSettingValue(setting: EditableAdminSetting, rawValue: string) {
  if (setting.inputType === 'boolean') {
    return normalizeBooleanValue(rawValue === '1' ? 'true' : rawValue.toLowerCase());
  }

  return rawValue;
}

function readEnvValue(key: string) {
  if (!fs.existsSync(envFilePath)) {
    return '';
  }

  const line = readEnvLines().find((entry) => entry.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1) : '';
}

export function getEditableAdminSettings() {
  return editableSettings.map((setting) => ({
    ...setting,
    value: readEnvValue(setting.key)
  }));
}

export function updateEditableAdminSettings(updates: Record<string, string>) {
  const lines = readEnvLines();
  const allowedKeys = new Set(editableSettings.map((setting) => setting.key));

  for (const [key, rawValue] of Object.entries(updates)) {
    if (!allowedKeys.has(key)) {
      continue;
    }

    const setting = editableSettings.find((item) => item.key === key);
    if (!setting) {
      continue;
    }

    const value = normalizeSettingValue(setting, String(rawValue));
    const nextLine = `${key}=${value}`;
    const lineIndex = lines.findIndex((entry) => entry.startsWith(`${key}=`));

    if (lineIndex >= 0) {
      lines[lineIndex] = nextLine;
    } else {
      lines.push(nextLine);
    }
  }

  writeEnvLines(lines);
  return getEditableAdminSettings();
}

export function authenticateAdmin(username: string, password: string) {
  const authState = readAuthState();
  if (username !== authState.username) {
    return null;
  }

  const expectedHash = Buffer.from(authState.passwordHash, 'hex');
  const actualHash = Buffer.from(derivePasswordHash(password, authState.passwordSalt), 'hex');
  if (expectedHash.length !== actualHash.length || !timingSafeEqual(expectedHash, actualHash)) {
    return null;
  }

  const token = randomUUID();
  tokenStore.set(token, {
    username: authState.username,
    createdAt: new Date().toISOString()
  });

  return {
    token,
    username: authState.username
  };
}

export function getAdminSession(token: string | null | undefined) {
  if (!token) {
    return null;
  }

  return tokenStore.get(token) ?? null;
}

export function changeAdminPassword(username: string, currentPassword: string, nextPassword: string) {
  const authState = readAuthState();
  if (username !== authState.username) {
    return false;
  }

  const expectedHash = Buffer.from(authState.passwordHash, 'hex');
  const actualHash = Buffer.from(derivePasswordHash(currentPassword, authState.passwordSalt), 'hex');
  if (expectedHash.length !== actualHash.length || !timingSafeEqual(expectedHash, actualHash)) {
    return false;
  }

  const nextSalt = randomBytes(16).toString('hex');
  writeAuthState({
    username: authState.username,
    passwordSalt: nextSalt,
    passwordHash: derivePasswordHash(nextPassword, nextSalt),
    updatedAt: new Date().toISOString()
  });

  return true;
}
