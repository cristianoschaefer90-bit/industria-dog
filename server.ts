import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import {
  isStoreOpen,
  getStoreSchedule,
  saveStoreSchedule,
  StoreScheduleConfig,
  DEFAULT_SCHEDULE
} from './src/services/storeHours';
import {
  verifyAdminPassword,
  validateAdminToken,
  revokeAdminToken,
  changeAdminPassword
} from './src/services/adminAuth';

const app = express();
const PORT = 3000;

app.use(express.json());

// Middleware de verificação de autenticação de administrador
function requireAdminAuth(req: Request, res: Response, next: () => void) {
  const authHeader = req.headers.authorization;
  const customHeader = req.headers['x-admin-token'] as string;
  let token = customHeader;
  if (!token && authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }
  if (!token && req.body && req.body.adminToken) {
    token = String(req.body.adminToken);
  }
  if (!token && req.query && typeof req.query.token === 'string') {
    token = req.query.token;
  }

  // Se a senha foi informada diretamente
  if (!token && req.body && typeof req.body.password === 'string') {
    const check = verifyAdminPassword(req.body.password);
    if (check.success) {
      return next();
    }
  }

  if (!validateAdminToken(token)) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Acesso restrito. Faça login com a senha de administrador para continuar.'
    });
  }
  next();
}

// ============================================================================
// SISTEMA DE SINCRONIZAÇÃO EM TEMPO REAL (SERVER-SENT EVENTS - BROADCAST)
// Atualiza o horário instantaneamente para TODOS os usuários conectados
// ============================================================================
const sseClients = new Set<Response>();

export function broadcastStoreStatus() {
  try {
    const schedule = getStoreSchedule();
    const status = isStoreOpen(schedule);
    const payload = JSON.stringify({
      type: 'status_update',
      timestamp: Date.now(),
      success: true,
      schedule,
      ...status
    });

    for (const client of sseClients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch (err) {
        sseClients.delete(client);
      }
    }
  } catch (err) {
    console.error('Erro no broadcast SSE:', err);
  }
}

// API: Stream em tempo real via Server-Sent Events (SSE)
app.get('/api/store-status/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Envia o estado atual imediatamente na conexão inicial
  try {
    const schedule = getStoreSchedule();
    const status = isStoreOpen(schedule);
    const initialPayload = JSON.stringify({
      type: 'status_update',
      timestamp: Date.now(),
      success: true,
      schedule,
      ...status
    });
    res.write(`data: ${initialPayload}\n\n`);
  } catch (e) {}

  sseClients.add(res);

  // Ping periódico a cada 20 segundos para manter conexões móveis vivas
  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(pingInterval);
      sseClients.delete(res);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(pingInterval);
    sseClients.delete(res);
  });
});

// Checagem periódica do servidor para viradas de horário automáticas (ex: 18:30 ou 23:00)
let lastKnownStatusOpen: boolean | null = null;
setInterval(() => {
  try {
    const schedule = getStoreSchedule();
    const status = isStoreOpen(schedule);
    if (lastKnownStatusOpen === null || lastKnownStatusOpen !== status.isOpen) {
      lastKnownStatusOpen = status.isOpen;
      broadcastStoreStatus();
    }
  } catch (e) {}
}, 20000);

// API: Retorna o status atual de funcionamento do restaurante no fuso horário oficial
app.get('/api/store-status', (req: Request, res: Response) => {
  try {
    const schedule = getStoreSchedule();
    const status = isStoreOpen(schedule);
    res.json({
      success: true,
      schedule,
      ...status
    });
  } catch (error) {
    console.error('Erro ao verificar store status:', error);
    res.status(500).json({
      success: false,
      isOpen: false,
      status: 'closed',
      message: 'Erro interno ao consultar horário da loja.'
    });
  }
});

// ============================================================================
// ROTAS ADMINISTRATIVAS PROTEGIDAS POR SENHA / TOKEN
// ============================================================================

// API: Login do Administrador
app.post('/api/admin/login', (req: Request, res: Response) => {
  const { password } = req.body || {};
  const result = verifyAdminPassword(password);
  if (!result.success) {
    return res.status(401).json({ success: false, error: result.error });
  }
  res.json({ success: true, token: result.token, message: 'Autenticado com sucesso!' });
});

// API: Logout do Administrador
app.post('/api/admin/logout', (req: Request, res: Response) => {
  const token = (req.headers['x-admin-token'] as string) || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.substring(7) : undefined);
  revokeAdminToken(token);
  res.json({ success: true, message: 'Sessão encerrada com sucesso.' });
});

// API: Verifica se a sessão do administrador ainda é válida
app.get('/api/admin/verify', (req: Request, res: Response) => {
  const token = (req.headers['x-admin-token'] as string) || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.substring(7) : undefined);
  const isValid = validateAdminToken(token);
  res.json({ success: isValid, authenticated: isValid });
});

// API: Altera a senha do administrador
app.post('/api/admin/change-password', requireAdminAuth, (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body || {};
  const result = changeAdminPassword(currentPassword, newPassword);
  if (!result.success) {
    return res.status(400).json({ success: false, error: result.error });
  }
  res.json({ success: true, message: 'Senha de administrador alterada com sucesso!' });
});

// API: Retorna a configuração completa dos horários (protegida para o Painel Admin)
app.get('/api/admin/schedule', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const schedule = getStoreSchedule();
    const currentStatus = isStoreOpen(schedule);
    res.json({
      success: true,
      schedule,
      currentStatus
    });
  } catch (error) {
    console.error('Erro ao carregar escala de horários:', error);
    res.status(500).json({ success: false, error: 'Falha ao obter horários' });
  }
});

// API: Salva alterações de horários feitas pelo administrador
app.post('/api/admin/schedule', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const body = req.body as StoreScheduleConfig;
    if (!body || !body.days) {
      return res.status(400).json({ success: false, error: 'Dados inválidos para a escala.' });
    }

    const saved = saveStoreSchedule(body);
    const updatedStatus = isStoreOpen(saved);

    // Notifica instantaneamente todos os clientes conectados em tempo real!
    broadcastStoreStatus();

    res.json({
      success: true,
      message: 'Horários de funcionamento atualizados com sucesso!',
      schedule: saved,
      currentStatus: updatedStatus
    });
  } catch (error) {
    console.error('Erro ao salvar horários:', error);
    res.status(500).json({ success: false, error: 'Falha ao salvar horários de funcionamento.' });
  }
});

// API: Override emergencial (Forçar Aberto / Forçar Fechado / Automático)
app.post('/api/admin/toggle-override', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const { override } = req.body;
    if (!['auto', 'force_open', 'force_closed'].includes(override)) {
      return res.status(400).json({ success: false, error: 'Override inválido.' });
    }

    const current = getStoreSchedule();
    current.manualOverride = override;
    saveStoreSchedule(current);

    const updatedStatus = isStoreOpen(current);

    // Notifica instantaneamente todos os clientes conectados em tempo real!
    broadcastStoreStatus();

    res.json({
      success: true,
      message: `Modo alterado para: ${override}`,
      currentStatus: updatedStatus
    });
  } catch (error) {
    console.error('Erro ao alternar override:', error);
    res.status(500).json({ success: false, error: 'Falha ao alterar override.' });
  }
});

// API: Validação de Pedido (Regras 7, 8 e 9 do Usuário)
// Rejeita qualquer tentativa de pedido se o estabelecimento estiver fechado no servidor!
app.post('/api/orders/validate', (req: Request, res: Response) => {
  const storeStatus = isStoreOpen();

  if (!storeStatus.isOpen) {
    return res.status(403).json({
      success: false,
      allowed: false,
      error: 'STORE_CLOSED',
      message: storeStatus.message,
      nextOpening: storeStatus.nextOpening,
      serverTime: storeStatus.serverTime
    });
  }

  res.json({
    success: true,
    allowed: true,
    message: 'Estabelecimento aberto. Pedido permitido.',
    currentTime: storeStatus.currentTime
  });
});

// API: Finalização e Registro de Pedido
app.post('/api/orders', (req: Request, res: Response) => {
  const storeStatus = isStoreOpen();

  // Regra 9: Rejeitar imediatamente com 403 se fechado
  if (!storeStatus.isOpen) {
    return res.status(403).json({
      success: false,
      error: 'STORE_CLOSED',
      message: 'Não é possível concluir o pedido: ' + storeStatus.message,
      nextOpening: storeStatus.nextOpening
    });
  }

  const orderData = req.body;
  const orderId = 'DOG-' + Date.now().toString().slice(-6);

  // Armazena pedido no histórico em arquivo para persistência
  try {
    const ordersDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(ordersDir)) {
      fs.mkdirSync(ordersDir, { recursive: true });
    }
    const ordersFile = path.resolve(ordersDir, 'orders_log.json');
    let orders: any[] = [];
    if (fs.existsSync(ordersFile)) {
      orders = JSON.parse(fs.readFileSync(ordersFile, 'utf-8'));
    }
    orders.unshift({
      id: orderId,
      createdAt: new Date().toISOString(),
      serverTime: storeStatus.serverTime,
      ...orderData
    });
    // Mantém os últimos 100 pedidos
    fs.writeFileSync(ordersFile, JSON.stringify(orders.slice(0, 100), null, 2), 'utf-8');
  } catch (err) {
    console.error('Erro ao salvar log de pedido:', err);
  }

  res.json({
    success: true,
    orderId,
    message: 'Pedido autorizado e registrado pelo servidor!',
    serverTime: storeStatus.serverTime
  });
});

// Inicialização com Vite em desenvolvimento ou estático em produção
async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Indústria do Dog Server] Rodando na porta ${PORT} (host: 0.0.0.0)`);
  });
}

start();
