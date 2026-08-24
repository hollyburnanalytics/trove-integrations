import type { Episode, Podcast, TranscriptSegment } from './shapes.ts';

/**
 * The model-visible text mirrors.
 *
 * Every tool returns both a `structured` payload and this text. The text is not
 * a summary of the structure — it is the part a model reads first, so it leads
 * with the identifiers a follow-up call needs (the uuid) and the one fact that
 * decides whether the next call will work (`transcribeStatus`), and leaves the
 * long-form fields to the structured half.
 */

/** One line per podcast: name, author, uuid, and the facts that pick a show. */
export function renderPodcastLine(podcast: Podcast): string {
  const bits = [
    podcast.author,
    podcast.totalEpisodes === null ? undefined : `${String(podcast.totalEpisodes)} episodes`,
    podcast.genres[0],
    podcast.popularityRank,
    // Only worth a mention when it is the useful value; NOT_TRANSCRIBING on a
    // series is the default and would be noise on every second line.
    podcast.transcribeStatus === 'TRANSCRIBING' ? 'auto-transcribed' : undefined,
  ].filter((bit): bit is string => typeof bit === 'string' && bit !== '');
  const facts = bits.length > 0 ? ` — ${bits.join(' · ')}` : '';
  return `  ${podcast.name}${facts}\n    uuid: ${podcast.uuid ?? '(none)'}`;
}

/** One line per episode. */
export function renderEpisodeLine(episode: Episode): string {
  const bits = [
    episode.podcast?.name,
    episode.datePublished,
    episode.duration,
    episode.transcribeStatus === 'COMPLETED' ? 'transcript ready' : undefined,
  ].filter((bit): bit is string => typeof bit === 'string' && bit !== '');
  const facts = bits.length > 0 ? ` — ${bits.join(' · ')}` : '';
  return `  ${episode.name}${facts}\n    uuid: ${episode.uuid ?? '(none)'}`;
}

/**
 * The vocabulary values a request was actually sent with, for the text mirror.
 *
 * Returns '' when nothing was filtered, so the common case adds no noise. When
 * something WAS filtered this is the line that stops a rewritten filter from
 * reading as a thin corpus — "tech" resolving to a genre the caller did not
 * name is only misleading if it stays invisible.
 */
export function renderFilters(filters: {
  genres?: string[];
  languages?: string[];
  countries?: string[];
}): string {
  const parts = [
    filters.genres?.length ? `genres: ${filters.genres.join(', ')}` : undefined,
    filters.languages?.length ? `languages: ${filters.languages.join(', ')}` : undefined,
    filters.countries?.length ? `countries: ${filters.countries.join(', ')}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? `Filtered by ${parts.join(' · ')}.` : '';
}

/** A search / chart / list result set. */
export function renderList(heading: string, lines: string[], footer?: string): string {
  if (lines.length === 0) return heading;
  return [heading, ...lines, ...(footer ? [footer] : [])].join('\n');
}

/** The full detail block for one podcast. */
export function renderPodcast(podcast: Podcast, episodes: Episode[]): string {
  const rows: string[] = [podcast.name];
  if (podcast.author) rows.push(`by ${podcast.author}`);
  const facts = [
    podcast.genres.join(', ') || undefined,
    podcast.language,
    podcast.contentType,
    podcast.seriesType,
    podcast.totalEpisodes === null ? undefined : `${String(podcast.totalEpisodes)} episodes`,
    podcast.datePublished ? `since ${podcast.datePublished}` : undefined,
    podcast.popularityRank,
    podcast.isCompleted === true ? 'completed' : undefined,
    podcast.isExplicit === true ? 'explicit' : undefined,
  ].filter((fact): fact is string => typeof fact === 'string' && fact !== '');
  if (facts.length > 0) rows.push(facts.join(' · '));
  rows.push(`uuid: ${podcast.uuid ?? '(none)'}`);
  if (podcast.rssUrl) rows.push(`rss: ${podcast.rssUrl}`);
  rows.push(`transcripts: ${describeSeriesTranscripts(podcast.transcribeStatus)}`);
  if (podcast.persons.length > 0) rows.push(`people: ${renderPersons(podcast.persons)}`);
  if (podcast.description) rows.push('', podcast.description);
  if (episodes.length > 0) {
    rows.push('', `${String(episodes.length)} episode(s):`);
    for (const episode of episodes) rows.push(renderEpisodeLine(episode));
  }
  return rows.join('\n');
}

/** `Justin Jackson (host), Jon Buda` — names, with roles where known. */
function renderPersons(persons: { name: string; role: string | null }[]): string {
  return persons
    .map((person) => (person.role ? `${person.name} (${person.role})` : person.name))
    .join(', ');
}

/** Say what a series-level transcribe status means for the caller's next call. */
function describeSeriesTranscripts(status: string | null): string {
  if (status === 'TRANSCRIBING') {
    return (
      'TRANSCRIBING — Taddy auto-transcribes every episode of this show, so get_transcript ' +
      'returns one immediately. These are TADDY-generated: they need a paid plan and count ' +
      'against the monthly transcript allowance.'
    );
  }
  return `${status ?? 'unknown'} — this show is not auto-transcribed, so an episode has a transcript only if the podcast supplies one (free), or you allow on-demand transcription (paid plan, spends a credit).`;
}

/** The full detail block for one episode. */
export function renderEpisode(episode: Episode): string {
  const rows: string[] = [episode.name];
  if (episode.podcast?.name) rows.push(`from ${episode.podcast.name}`);
  const facts = episodeFacts(episode);
  if (facts.length > 0) rows.push(facts.join(' · '));
  rows.push(
    `uuid: ${episode.uuid ?? '(none)'}`,
    `transcript: ${describeEpisodeTranscript(episode.transcribeStatus)}`,
  );
  if (episode.persons.length > 0) rows.push(`people: ${renderPersons(episode.persons)}`);
  if (episode.audioUrl) rows.push(`audio: ${episode.audioUrl}`);
  if (episode.description) rows.push('', episode.description);
  if (episode.chapters && episode.chapters.length > 0) {
    rows.push('', `${String(episode.chapters.length)} chapter(s):`);
    for (const chapter of episode.chapters) {
      rows.push(`  ${chapter.startTimecode ?? '—'}  ${chapter.title}`);
    }
  }
  return rows.join('\n');
}

/** The one-line fact strip for an episode, with the unremarkable values left out. */
function episodeFacts(episode: Episode): string[] {
  return [
    episode.datePublished,
    episode.duration,
    episode.episodeNumber === null ? undefined : `episode ${String(episode.episodeNumber)}`,
    episode.seasonNumber === null ? undefined : `season ${String(episode.seasonNumber)}`,
    // FULL is the default kind and says nothing; TRAILER and BONUS do.
    episode.episodeType === 'FULL' ? undefined : (episode.episodeType ?? undefined),
    episode.isExplicit === true ? 'explicit' : undefined,
    episode.isRemoved === true ? 'REMOVED from feed' : undefined,
  ].filter((fact): fact is string => typeof fact === 'string' && fact !== '');
}

/** Say what an episode-level transcribe status means, in plain terms. */
function describeEpisodeTranscript(status: string | null): string {
  switch (status) {
    case 'COMPLETED': {
      return (
        'COMPLETED — a transcript is ready; call get_transcript. Note this value covers BOTH a ' +
        'podcast-supplied transcript (free) and one Taddy generated (paid plan, counts against ' +
        'the monthly allowance), and does not say which.'
      );
    }
    case 'PROCESSING': {
      return 'PROCESSING — queued at Taddy (the queue runs to thousands of episodes, so this is not necessarily soon). get_transcript can still produce one on demand on a paid plan, at the cost of a credit.';
    }
    case 'NOT_TRANSCRIBING': {
      return 'NOT_TRANSCRIBING — Taddy has not transcribed this episode. get_transcript still returns a transcript the PODCAST supplies (free); failing that it needs allow_on_demand: true (paid plan, spends a credit).';
    }
    default: {
      return status ?? 'unknown';
    }
  }
}

/**
 * The transcript itself.
 *
 * Speaker labels are only emitted when they CHANGE. Repeating "Speaker 1:" on
 * every one of four hundred utterances triples the size of the transcript for
 * no added information.
 */
export function renderTranscript(
  segments: TranscriptSegment[],
  options: { showTimecodes: boolean },
): string {
  const rows: string[] = [];
  let lastSpeaker: string | null = null;
  for (const segment of segments) {
    const prefix =
      options.showTimecodes && segment.startTimecode ? `[${segment.startTimecode}] ` : '';
    if (segment.speaker && segment.speaker !== lastSpeaker) {
      rows.push(`\n${segment.speaker}:`);
      lastSpeaker = segment.speaker;
    }
    rows.push(`${prefix}${segment.text}`);
  }
  return rows.join('\n').trim();
}
