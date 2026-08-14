export type University = {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  domain: string;
  aliases: string[];
  abbreviation: string;
};

type CompactUniversity = [string, string, string, string, string[]];

let universityPromise: Promise<University[]> | null = null;

function normalise(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function abbreviation(name: string, aliases: string[], domain: string): string {
  const domainAlias = domain.split('.')[0]?.replace(/[^a-z0-9]/gi, '') ?? '';
  const candidate = aliases.find((alias) => alias === domainAlias) || aliases[0] || '';
  if (candidate.length >= 2 && candidate.length <= 8) return candidate.toUpperCase();
  return name
    .split(/\s+/)
    .filter((word) => !/^(?:and|of|the|for|at|in)$/i.test(word))
    .map((word) => word[0])
    .join('')
    .slice(0, 8)
    .toUpperCase();
}

function localCountryCode(): string {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timeZone === 'Asia/Kuala_Lumpur' || timeZone === 'Asia/Kuching') return 'MY';
    if (timeZone === 'Asia/Singapore') return 'SG';
    if (timeZone === 'Asia/Jakarta' || timeZone === 'Asia/Makassar' || timeZone === 'Asia/Jayapura') return 'ID';
    if (timeZone === 'Asia/Manila') return 'PH';
    if (timeZone === 'Asia/Bangkok') return 'TH';
    if (timeZone === 'Europe/London') return 'GB';
    if (/^America\//.test(timeZone)) return 'US';
  } catch {
    /* Locale ranking is optional. */
  }
  return '';
}

async function loadUniversities(): Promise<University[]> {
  universityPromise ??= fetch('/data/universities.min.json', { cache: 'force-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`University directory returned HTTP ${response.status}.`);
      return response.json() as Promise<CompactUniversity[]>;
    })
    .then((rows) =>
      rows.map(([name, country, countryCode, domain, aliases]) => ({
        id: domain || `${countryCode}:${normalise(name)}`,
        name,
        country,
        countryCode,
        domain,
        aliases,
        abbreviation: abbreviation(name, aliases, domain),
      }))
    );
  return universityPromise;
}

export async function searchUniversities(raw: string, count = 8): Promise<University[]> {
  const query = normalise(raw.replace(/^@/, ''));
  if (query.length < 2) return [];
  const universities = await loadUniversities();
  const preferredCountry = localCountryCode();

  return universities
    .flatMap((university) => {
      const name = normalise(university.name);
      const country = normalise(university.country);
      const domain = normalise(university.domain);
      const aliases = university.aliases.map(normalise);
      let score = 0;
      if (aliases.includes(query)) score = 100;
      else if (domain === query || domain.startsWith(`${query} `)) score = 95;
      else if (name === query) score = 90;
      else if (name.startsWith(query)) score = 80;
      else if (name.split(' ').some((word) => word.startsWith(query))) score = 65;
      else if (domain.startsWith(query)) score = 60;
      else if (name.includes(query) || country.startsWith(query)) score = 40;
      if (score && preferredCountry && university.countryCode === preferredCountry) score += 18;
      return score ? [{ university, score }] : [];
    })
    .sort((left, right) => right.score - left.score || left.university.name.localeCompare(right.university.name))
    .slice(0, count)
    .map((entry) => entry.university);
}

export function universityLabel(input: {
  university?: string;
  universityAbbreviation?: string;
}): string {
  const name = input.university?.trim() ?? '';
  const short = input.universityAbbreviation?.trim().toUpperCase() ?? '';
  if (!name) return 'University not added';
  return short && !name.toUpperCase().includes(`(${short})`) ? `${name} (${short})` : name;
}

export function universitySearchKey(value: string): string {
  return normalise(value);
}
