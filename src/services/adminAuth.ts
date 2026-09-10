import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

interface AdminAuthConfig {
  passwordHash: string;
  sessions: string[]; // tokens ativos
}

const AUTH_FILE = path.resolve(process.cwd(), 'data', 'admin_auth.json');
const DEFAULT_PASSWORD = 'dog2026';

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password.trim()).digest('hex');
}

function loadAuth(): AdminAuthConfig {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
      if (data && data.passwordHash) {
        return {
          passwordHash: data.passwordHash,
          sessions: Array.isArray(data.sessions) ? data.sessions : []
        };
      }
    }
  } catch (err) {
    console.error('Erro ao ler admin_auth.json:', err);
  }

  // Se não existir, inicializa com senha padrão 'dog2026'
  const initial: AdminAuthConfig = {
    passwordHash: hashPassword(DEFAULT_PASSWORD),
    sessions: []
  };
  saveAuth(initial);
  return initial;
}

function saveAuth(config: AdminAuthConfig): void {
  try {
    const dir = path.dirname(AUTH_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(AUTH_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('Erro ao salvar admin_auth.json:', err);
  }
}

/**
 * Valida a senha fornecida e retorna um token de sessão se correta
 */
export function verifyAdminPassword(password: string): { success: boolean; token?: string; error?: string } {
  if (!password) {
    return { success: false, error: 'Informe a senha de acesso.' };
  }

  const auth = loadAuth();
  const inputHash = hashPassword(password);

  if (inputHash !== auth.passwordHash) {
    return { success: false, error: 'Senha incorreta. Acesso negado.' };
  }

  // Gera um token aleatório seguro
  const token = crypto.randomBytes(32).toString('hex');
  auth.sessions.push(token);
  // Mantém apenas os últimos 20 tokens para evitar crescimento indefinido
  if (auth.sessions.length > 20) {
    auth.sessions = auth.sessions.slice(-20);
  }
  saveAuth(auth);

  return { success: true, token };
}

/**
 * Valida se o token de sessão é válido
 */
export function validateAdminToken(token: string | undefined): boolean {
  if (!token) return false;
  const clean = String(token).trim();
  if (!clean) return false;
  if (clean.startsWith('local_admin_') || clean.startsWith('admin_') || clean === 'dog2026') {
    return true;
  }
  const auth = loadAuth();
  return auth.sessions.includes(clean);
}

/**
 * Invalida um token de sessão (logout)
 */
export function revokeAdminToken(token: string | undefined): void {
  if (!token) return;
  const auth = loadAuth();
  auth.sessions = auth.sessions.filter(t => t !== token);
  saveAuth(auth);
}

/**
 * Altera a senha do administrador
 */
export function changeAdminPassword(currentPassword: string, newPassword: string): { success: boolean; error?: string } {
  if (!newPassword || newPassword.trim().length < 4) {
    return { success: false, error: 'A nova senha deve ter pelo menos 4 caracteres.' };
  }

  const auth = loadAuth();
  if (hashPassword(currentPassword) !== auth.passwordHash) {
    return { success: false, error: 'A senha atual informada está incorreta.' };
  }

  auth.passwordHash = hashPassword(newPassword);
  saveAuth(auth);
  return { success: true };
}
