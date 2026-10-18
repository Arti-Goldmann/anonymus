/** Colors shared by all screens; the accent matches the mascot's body. */
export const theme = {
  accent: "#E8693F",
  muted: "gray",
  ok: "green",
  warn: "yellow",
  error: "red",
  info: "cyan",
  project: "#7AA2F7",
  sandbox: "#BB9AF7",
} as const;

export function formatTime(d: Date): string {
  return d.toLocaleTimeString("ru-RU", { hour12: false });
}

/** Russian plural: plural(5, "файл", "файла", "файлов") -> "файлов". */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
