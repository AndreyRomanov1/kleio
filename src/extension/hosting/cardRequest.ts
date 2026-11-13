import type { CardResult } from './mergeRequestCards';
import { t } from '../../shared/l10n';

export async function cardRequest(load: () => Promise<CardResult>, timeoutMs = 45_000): Promise<CardResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(load),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(t('Loading the merge request timed out. Check your connection and retry.'))),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
