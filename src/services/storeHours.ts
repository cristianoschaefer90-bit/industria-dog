import fs from 'fs';
import path from 'path';

export type DayOfWeek = 'domingo' | 'segunda' | 'terca' | 'quarta' | 'quinta' | 'sexta' | 'sabado';

export const DAYS_ORDER: DayOfWeek[] = [
  'domingo',
  'segunda',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sabado'
];

export const DAYS_LABELS: Record<DayOfWeek, string> = {
  domingo: 'Domingo',
  segunda: 'Segunda-feira',
  terca: 'Terça-feira',
  quarta: 'Quarta-feira',
  quinta: 'Quinta-feira',
  sexta: 'Sexta-feira',
  sabado: 'Sábado'
};

export interface TimePeriod {
  open: string;  // "HH:mm", e.g. "11:00"
  close: string; // "HH:mm", e.g. "14:00" ou "01:00"
}

export interface DaySchedule {
  isOpen: boolean;
  periods: TimePeriod[];
}

export interface StoreScheduleConfig {
  timezone: string; // e.g. "America/Sao_Paulo"
  manualOverride: 'auto' | 'force_open' | 'force_closed';
  days: Record<DayOfWeek, DaySchedule>;
}

export interface NextOpeningInfo {
  day: DayOfWeek;
  dayLabel: string;
  time: string;
  formatted: string;
  relativeText: string;
}

export interface StoreStatusResult {
  isOpen: boolean;
  status: 'open' | 'closed';
  reason: 'open' | 'closed_day' | 'outside_hours' | 'manual_force_closed' | 'manual_force_open';
  message: string;
  currentDay: DayOfWeek;
  currentDayLabel: string;
  currentTime: string;
  timezone: string;
  todayPeriods: TimePeriod[];
  manualOverride: 'auto' | 'force_open' | 'force_closed';
  nextOpening: NextOpeningInfo | null;
  serverTime: string;
}

// Horário padrão da Indústria do Dog
// Aberto de domingo a sexta das 18:30 às 23:00 (sábado fechado)
export const DEFAULT_SCHEDULE: StoreScheduleConfig = {
  timezone: 'America/Sao_Paulo',
  manualOverride: 'auto',
  days: {
    domingo: {
      isOpen: true,
      periods: [{ open: '18:30', close: '23:00' }]
    },
    segunda: {
      isOpen: true,
      periods: [{ open: '18:30', close: '23:00' }]
    },
    terca: {
      isOpen: true,
      periods: [{ open: '18:30', close: '23:00' }]
    },
    quarta: {
      isOpen: true,
      periods: [{ open: '18:30', close: '23:00' }]
    },
    quinta: {
      isOpen: true,
      periods: [{ open: '18:30', close: '23:00' }]
    },
    sexta: {
      isOpen: true,
      periods: [{ open: '18:30', close: '23:00' }]
    },
    sabado: {
      isOpen: false,
      periods: [{ open: '18:30', close: '23:00' }]
    }
  }
};

const DATA_FILE_PATH = path.resolve(process.cwd(), 'data', 'store_schedule.json');

/**
 * Lê a configuração atual de horários com fallback para padrão
 */
export function getStoreSchedule(): StoreScheduleConfig {
  try {
    if (fs.existsSync(DATA_FILE_PATH)) {
      const raw = fs.readFileSync(DATA_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SCHEDULE,
        ...parsed,
        days: {
          ...DEFAULT_SCHEDULE.days,
          ...(parsed.days || {})
        }
      };
    }
  } catch (err) {
    console.error('Erro ao ler store_schedule.json, usando padrão:', err);
  }
  return DEFAULT_SCHEDULE;
}

/**
 * Salva a nova configuração de horários de forma persistente
 */
export function saveStoreSchedule(config: StoreScheduleConfig): StoreScheduleConfig {
  const dir = path.dirname(DATA_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Sanitiza e valida horários
  const sanitized: StoreScheduleConfig = {
    timezone: config.timezone || 'America/Sao_Paulo',
    manualOverride: config.manualOverride || 'auto',
    days: {} as Record<DayOfWeek, DaySchedule>
  };

  for (const day of DAYS_ORDER) {
    const dayData = config.days[day] || { isOpen: false, periods: [] };
    sanitized.days[day] = {
      isOpen: Boolean(dayData.isOpen),
      periods: Array.isArray(dayData.periods)
        ? dayData.periods
            .filter(p => typeof p.open === 'string' && typeof p.close === 'string')
            .map(p => ({
              open: p.open.trim().slice(0, 5),
              close: p.close.trim().slice(0, 5)
            }))
        : []
    };
  }

  fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(sanitized, null, 2), 'utf-8');
  return sanitized;
}

/**
 * Converte "HH:mm" em minutos do dia (0 a 1439)
 */
export function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Formata minutos do dia em "HH:mm"
 */
export function minutesToTime(minutes: number): string {
  const norm = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(norm / 60);
  const m = norm % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Obtém informações de data/hora no fuso horário configurado
 */
export function getNowInTimezone(timezone: string, customDate?: Date): {
  dayOfWeek: DayOfWeek;
  dayIndex: number;
  timeStr: string;
  minutesNow: number;
  dateObj: Date;
} {
  const date = customDate || new Date();
  
  // Extrai componentes de data e hora no fuso horário especificado
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  let weekday = '';
  let hour = '00';
  let minute = '00';

  for (const part of parts) {
    if (part.type === 'weekday') weekday = part.value;
    if (part.type === 'hour') hour = part.value;
    if (part.type === 'minute') minute = part.value;
  }

  // Mapeia weekday para DayOfWeek
  const mapWeekday: Record<string, { day: DayOfWeek; index: number }> = {
    Sun: { day: 'domingo', index: 0 },
    Mon: { day: 'segunda', index: 1 },
    Tue: { day: 'terca', index: 2 },
    Wed: { day: 'quarta', index: 3 },
    Thu: { day: 'quinta', index: 4 },
    Fri: { day: 'sexta', index: 5 },
    Sat: { day: 'sabado', index: 6 }
  };

  const dayInfo = mapWeekday[weekday] || { day: 'domingo', index: 0 };
  const timeStr = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  const minutesNow = timeToMinutes(timeStr);

  return {
    dayOfWeek: dayInfo.day,
    dayIndex: dayInfo.index,
    timeStr,
    minutesNow,
    dateObj: date
  };
}

/**
 * Verifica se um horário em minutos está dentro de um período configurado.
 * Suporta períodos dentro do mesmo dia (ex: 18:30 - 23:00)
 * e períodos que viram a noite (ex: 18:00 - 01:00)
 */
function isTimeInPeriod(nowMin: number, openMin: number, closeMin: number): boolean {
  if (openMin <= closeMin) {
    // Período regular diurno/noturno dentro do mesmo dia
    return nowMin >= openMin && nowMin < closeMin;
  } else {
    // Período que cruza a meia-noite (ex: 18:00 até 02:00)
    return nowMin >= openMin || nowMin < closeMin;
  }
}

/**
 * Calcula a próxima abertura do estabelecimento
 */
export function calculateNextOpening(
  schedule: StoreScheduleConfig,
  currentDayIndex: number,
  currentMinutes: number
): NextOpeningInfo | null {
  // Procura nos próximos 8 dias
  for (let offset = 0; offset <= 7; offset++) {
    const targetDayIndex = (currentDayIndex + offset) % 7;
    const targetDay = DAYS_ORDER[targetDayIndex];
    const dayConfig = schedule.days[targetDay];

    if (!dayConfig || !dayConfig.isOpen || !dayConfig.periods.length) {
      continue;
    }

    // Ordena os períodos do dia por horário de abertura
    const sortedPeriods = [...dayConfig.periods].sort(
      (a, b) => timeToMinutes(a.open) - timeToMinutes(b.open)
    );

    for (const period of sortedPeriods) {
      const openMin = timeToMinutes(period.open);

      if (offset === 0) {
        // É hoje: só é próxima abertura se for no futuro
        if (openMin > currentMinutes) {
          return {
            day: targetDay,
            dayLabel: DAYS_LABELS[targetDay],
            time: period.open,
            formatted: `Hoje às ${period.open}`,
            relativeText: `hoje às ${period.open}`
          };
        }
      } else if (offset === 1) {
        return {
          day: targetDay,
          dayLabel: DAYS_LABELS[targetDay],
          time: period.open,
          formatted: `Amanhã (${DAYS_LABELS[targetDay]}) às ${period.open}`,
          relativeText: `amanhã às ${period.open}`
        };
      } else {
        return {
          day: targetDay,
          dayLabel: DAYS_LABELS[targetDay],
          time: period.open,
          formatted: `${DAYS_LABELS[targetDay]} às ${period.open}`,
          relativeText: `na ${DAYS_LABELS[targetDay].toLowerCase()} às ${period.open}`
        };
      }
    }
  }

  return null;
}

/**
 * FUNÇÃO CENTRAL DE VERIFICAÇÃO DE FUNCIONAMENTO
 * Regra 8 do Usuário: isStoreOpen()
 * Retorna se a loja está aberta, status detalhado e próxima abertura
 */
export function isStoreOpen(
  customConfig?: StoreScheduleConfig,
  customDate?: Date
): StoreStatusResult {
  const schedule = customConfig || getStoreSchedule();
  const timezone = schedule.timezone || 'America/Sao_Paulo';
  const now = getNowInTimezone(timezone, customDate);

  // 1. Checa se há Override Manual (Admin pode forçar abertura ou fechamento de emergência)
  if (schedule.manualOverride === 'force_open') {
    return {
      isOpen: true,
      status: 'open',
      reason: 'manual_force_open',
      message: 'Estamos abertos! Faça seu pedido agora.',
      currentDay: now.dayOfWeek,
      currentDayLabel: DAYS_LABELS[now.dayOfWeek],
      currentTime: now.timeStr,
      timezone,
      todayPeriods: schedule.days[now.dayOfWeek]?.periods || [],
      manualOverride: 'force_open',
      nextOpening: null,
      serverTime: now.dateObj.toISOString()
    };
  }

  if (schedule.manualOverride === 'force_closed') {
    const nextOpening = calculateNextOpening(schedule, now.dayIndex, now.minutesNow);
    return {
      isOpen: false,
      status: 'closed',
      reason: 'manual_force_closed',
      message: 'Estamos fechados no momento por pausa operacional temporária.',
      currentDay: now.dayOfWeek,
      currentDayLabel: DAYS_LABELS[now.dayOfWeek],
      currentTime: now.timeStr,
      timezone,
      todayPeriods: schedule.days[now.dayOfWeek]?.periods || [],
      manualOverride: 'force_closed',
      nextOpening,
      serverTime: now.dateObj.toISOString()
    };
  }

  const todayConfig = schedule.days[now.dayOfWeek];

  // 2. Checa se o estabelecimento estava aberto no período da madrugada vindo do dia anterior
  // Exemplo: Sexta 18:00 - 02:00 (Sábado de madrugada). Às 01:15 de sábado ainda é o turno de sexta!
  const prevDayIndex = (now.dayIndex + 6) % 7;
  const prevDay = DAYS_ORDER[prevDayIndex];
  const prevDayConfig = schedule.days[prevDay];

  if (prevDayConfig && prevDayConfig.isOpen) {
    for (const period of prevDayConfig.periods) {
      const openMin = timeToMinutes(period.open);
      const closeMin = timeToMinutes(period.close);
      if (openMin > closeMin) {
        // Vira a noite
        if (now.minutesNow < closeMin) {
          return {
            isOpen: true,
            status: 'open',
            reason: 'open',
            message: 'Estamos abertos! Faça seu pedido.',
            currentDay: now.dayOfWeek,
            currentDayLabel: DAYS_LABELS[now.dayOfWeek],
            currentTime: now.timeStr,
            timezone,
            todayPeriods: prevDayConfig.periods,
            manualOverride: 'auto',
            nextOpening: null,
            serverTime: now.dateObj.toISOString()
          };
        }
      }
    }
  }

  // 3. Checa se o dia atual está marcado como FECHADO
  if (!todayConfig || !todayConfig.isOpen || !todayConfig.periods.length) {
    const nextOpening = calculateNextOpening(schedule, now.dayIndex, now.minutesNow);
    const nextMsg = nextOpening
      ? ` Os pedidos estarão disponíveis novamente ${nextOpening.relativeText}.`
      : '';

    return {
      isOpen: false,
      status: 'closed',
      reason: 'closed_day',
      message: `Estamos fechados hoje (${DAYS_LABELS[now.dayOfWeek]}).${nextMsg}`,
      currentDay: now.dayOfWeek,
      currentDayLabel: DAYS_LABELS[now.dayOfWeek],
      currentTime: now.timeStr,
      timezone,
      todayPeriods: [],
      manualOverride: 'auto',
      nextOpening,
      serverTime: now.dateObj.toISOString()
    };
  }

  // 4. Checa períodos de hoje
  let isInsideAnyPeriod = false;
  for (const period of todayConfig.periods) {
    const openMin = timeToMinutes(period.open);
    const closeMin = timeToMinutes(period.close);
    if (isTimeInPeriod(now.minutesNow, openMin, closeMin)) {
      isInsideAnyPeriod = true;
      break;
    }
  }

  if (isInsideAnyPeriod) {
    return {
      isOpen: true,
      status: 'open',
      reason: 'open',
      message: 'Estamos abertos! Faça seu pedido.',
      currentDay: now.dayOfWeek,
      currentDayLabel: DAYS_LABELS[now.dayOfWeek],
      currentTime: now.timeStr,
      timezone,
      todayPeriods: todayConfig.periods,
      manualOverride: 'auto',
      nextOpening: null,
      serverTime: now.dateObj.toISOString()
    };
  }

  // 5. Fora do horário
  const nextOpening = calculateNextOpening(schedule, now.dayIndex, now.minutesNow);
  const nextMsg = nextOpening
    ? ` Os pedidos estarão disponíveis novamente ${nextOpening.relativeText}.`
    : '';

  return {
    isOpen: false,
    status: 'closed',
    reason: 'outside_hours',
    message: `Estamos fechados no momento.${nextMsg}`,
    currentDay: now.dayOfWeek,
    currentDayLabel: DAYS_LABELS[now.dayOfWeek],
    currentTime: now.timeStr,
    timezone,
    todayPeriods: todayConfig.periods,
    manualOverride: 'auto',
    nextOpening,
    serverTime: now.dateObj.toISOString()
  };
}
