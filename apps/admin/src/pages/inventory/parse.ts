/** 解析「每行一个：邮箱----密码----其他信息」，也支持空格、逗号或 Tab 分隔 */
export function parseAccountLines(text: string) {
  const rows: { email: string; password: string; secretNote?: string }[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/-{2,}|\t|,|，|\s+/).filter(Boolean);
    const [email, password, ...rest] = parts;
    if (!email || !password || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      bad.push(line);
      continue;
    }
    rows.push({ email, password, secretNote: rest.length ? rest.join(' ') : undefined });
  }
  return { rows, bad };
}
