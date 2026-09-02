const CALENDAR_ID = '3ce869336631ecb67d078836f5f745b05fece0214b83a1eeaa496bea0f4f15c1@group.calendar.google.com';

/**
 * 公開カレンダーから、サイトに必要な予定情報だけを返します。
 * GOOGLE_CALENDAR_API_KEY が Cloudflare Pages の環境変数に設定されて
 * いれば Calendar API を使い、未設定時は公開ICSをフォールバックにします。
 * どちらの場合も creator / organizer / attendees は返しません。
 */
export async function onRequestGet(context) {
  const { env } = context;
  const apiKey = env.GOOGLE_CALENDAR_API_KEY;

  try {
    const events = apiKey ? await fetchCalendarApi(apiKey) : await fetchPublicIcs();
    return jsonResponse({ events, source: apiKey ? 'calendar-api' : 'public-ics' });
  } catch (error) {
    console.error('Calendar fetch failed:', error);

    // APIキー設定後にAPI側で一時的なエラーがあっても、公開ICSで表示を継続します。
    try {
      const events = await fetchPublicIcs();
      return jsonResponse({ events, source: 'public-ics-fallback' });
    } catch (fallbackError) {
      console.error('Calendar ICS fallback failed:', fallbackError);
      return jsonResponse(
        { error: 'calendar_unavailable', message: 'カレンダーを取得できませんでした。' },
        502,
      );
    }
  }
}

async function fetchCalendarApi(apiKey) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
  );
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('timeMin', new Date().toISOString());
  url.searchParams.set('maxResults', '100');
  url.searchParams.set('showDeleted', 'false');
  url.searchParams.set('key', apiKey);
  // メールアドレスを持つ creator / organizer / attendees をAPI応答から除外します。
  url.searchParams.set('fields', 'items(id,summary,description,location,start,end)');

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`Google Calendar API returned ${response.status}`);

  const data = await response.json();
  return (data.items || []).map(normalizeApiEvent).filter(Boolean);
}

function normalizeApiEvent(event) {
  if (!event?.start || !event?.end || !event.summary) return null;
  return {
    id: event.id || `${event.summary}-${event.start.date || event.start.dateTime}`,
    summary: String(event.summary),
    description: event.description ? String(event.description) : '',
    location: event.location ? String(event.location) : '',
    start: pickDateValue(event.start),
    end: pickDateValue(event.end),
  };
}

function pickDateValue(value) {
  if (value.date) return { date: value.date };
  if (value.dateTime) return { dateTime: value.dateTime };
  return {};
}

async function fetchPublicIcs() {
  const icsUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(CALENDAR_ID)}/public/basic.ics`;
  const response = await fetch(icsUrl, {
    headers: { Accept: 'text/calendar,text/plain;q=0.9' },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`Google public ICS returned ${response.status}`);
  return parseIcs(await response.text());
}

function parseIcs(ics) {
  const lines = unfoldIcs(ics).split(/\r?\n/);
  const events = [];
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      const normalized = normalizeIcsEvent(current);
      if (normalized) events.push(normalized);
      current = null;
      continue;
    }
    if (!current) continue;

    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const left = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const [name, ...parameterParts] = left.split(';');
    const parameters = {};
    for (const part of parameterParts) {
      const [key, parameterValue = ''] = part.split('=');
      parameters[key.toUpperCase()] = parameterValue;
    }
    current[name.toUpperCase()] = { value, parameters };
  }

  return events
    .sort((a, b) => dateSortValue(a.start) - dateSortValue(b.start))
    .slice(0, 100);
}

function unfoldIcs(ics) {
  return ics.replace(/\r?\n[ \t]/g, '');
}

function normalizeIcsEvent(event) {
  const start = parseIcsDate(event.DTSTART);
  const end = parseIcsDate(event.DTEND);
  if (!start || !end || !event.SUMMARY) return null;
  return {
    id: event.UID?.value || `${event.SUMMARY.value}-${start.date || start.dateTime}`,
    summary: unescapeIcs(event.SUMMARY.value),
    description: event.DESCRIPTION ? unescapeIcs(event.DESCRIPTION.value) : '',
    location: event.LOCATION ? unescapeIcs(event.LOCATION.value) : '',
    start,
    end,
  };
}

function parseIcsDate(property) {
  if (!property?.value) return null;
  const value = property.value;
  if (/^\d{8}$/.test(value)) {
    return { date: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` };
  }

  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  if (utc === 'Z') return { dateTime: `${year}-${month}-${day}T${hour}:${minute}:${second}Z` };

  // 公開カレンダーは Asia/Tokyo 設定のため、TZIDなしも日本時間として扱います。
  const offset = property.parameters.TZID === 'Asia/Tokyo' || !property.parameters.TZID
    ? '+09:00'
    : '';
  return { dateTime: `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}` };
}

function unescapeIcs(value) {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function dateSortValue(value) {
  return value?.dateTime
    ? Date.parse(value.dateTime)
    : Date.parse(`${value?.date || '9999-12-31'}T00:00:00+09:00`);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60, s-maxage=300',
      'access-control-allow-origin': '*',
    },
  });
}
