import { setL10nBundle } from '../shared/l10n';

// Imported first by the entry point: other modules translate labels as they load.
setL10nBundle(JSON.parse(document.getElementById('l10n')?.textContent || '{}') as Record<string, string>);
