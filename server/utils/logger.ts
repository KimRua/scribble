type LogLevel = 'info' | 'error';

interface LogEntry {
  level: LogLevel;
  event: string;
  timestamp: string;
  [key: string]: string | number | boolean | null | undefined;
}

function writeLog(entry: LogEntry) {
  const serialized = JSON.stringify(entry);
  if (entry.level === 'error') {
    console.error(serialized);
    return;
  }

  console.log(serialized);
}

export function logInfo(event: string, fields: Omit<LogEntry, 'level' | 'event' | 'timestamp'> = {}) {
  writeLog({
    level: 'info',
    event,
    timestamp: new Date().toISOString(),
    ...fields
  });
}

export function logError(event: string, fields: Omit<LogEntry, 'level' | 'event' | 'timestamp'> = {}) {
  writeLog({
    level: 'error',
    event,
    timestamp: new Date().toISOString(),
    ...fields
  });
}
