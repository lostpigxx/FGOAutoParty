export function saveConfigFile(
  root: string,
  body: string,
): Promise<{ ok: boolean; path?: string; error?: string }>;
