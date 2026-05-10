# Social Media Challenge — Cypher Queries

All queries tested against the live local graph (196 releases, 2108 tracks, 2928 musicians).
Copy any query directly into the Neo4j Browser at http://localhost:7474.

---

## 1. What artists are similar to Frank Sinatra?

Frank Sinatra is not in the collection, so his genre/style/decade profile is injected
directly from Discogs data (artist ID 52833, sampled across his canonical albums).
Similarity is scored by shared genres (×3), styles (×2), and active decade (×1).

Returns the top 7 matching artists, each with up to 5 representative songs from their
genre-matching releases. Songs are ordered as they appear on the album.

```cypher
// Sinatra's Discogs profile — injected so we can query without him in the collection
WITH ['Jazz', 'Pop']                          AS sinatraGenres,
     ['Swing', 'Ballad', 'Vocal', 'Big Band'] AS sinatraStyles,
     ['1950s']                                AS sinatraDecades

MATCH (a:Artist)<-[:RELEASED_BY]-(r:Release)
WITH sinatraGenres, sinatraStyles, sinatraDecades, a, r
WITH sinatraGenres, sinatraStyles, sinatraDecades, a, r,
     [g IN [(r)-[:IN_GENRE]->(g2)          | g2.name] WHERE g IN sinatraGenres] AS sharedGenres,
     [s IN [(r)-[:IN_STYLE]->(s2)          | s2.name] WHERE s IN sinatraStyles] AS sharedStyles,
     [d IN [(r)-[:RECORDED_IN_DECADE]->(d2) | d2.name] WHERE d IN sinatraDecades] AS sharedDecades
WITH a, r,
     size(sharedGenres)*3 + size(sharedStyles)*2 + size(sharedDecades) AS score,
     sharedGenres, sharedStyles
WHERE score > 0

// Roll up to artist level, cap at top 7 artists
WITH a, max(score) AS score, collect(r) AS releases,
     collect(DISTINCT sharedGenres)[0] AS sharedGenres,
     collect(DISTINCT sharedStyles)[0] AS sharedStyles
ORDER BY score DESC LIMIT 7

// Pull up to 5 songs per artist from the matching releases
UNWIND releases AS r
MATCH (r)-[:HAS_TRACK]->(t:Track)
WITH a, score, sharedGenres, sharedStyles,
     collect(DISTINCT {song: t.title, album: r.title, duration: t.duration})[0..5] AS songs

RETURN a.name        AS artist,
       score,
       sharedGenres  AS genres,
       sharedStyles  AS styles,
       songs
ORDER BY score DESC
```

> **Top matches:**
>
> - **Judy Garland** (9) — "Chicago", "Over The Rainbow", "Stormy Weather"
> - **Norah Jones** (8) — "Burn", "Tragedy", "Flipside"
> - **Nat King Cole** (8) — "When The World Was Young", "Star Dust"
> - **Carly Simon** (7), **Prince** (5), **James Taylor** (5), **Janis Ian** (5)

---

## 2. Find me a song that references a potato

Uses the full-text index on lyrics. Returns the lines that contain "potato" (up to 2)
alongside the track, album, and artist.

One row per track. Multiple artists on the same release are collected into a list.
Scoped to `lrclib` lyrics only — Genius lyrics currently contain scraped book text
that produces false positives (see issue #31).

```cypher
CALL db.index.fulltext.queryNodes('trackLyrics', 'potato') YIELD node AS t, score
WHERE toLower(t.lyrics) CONTAINS 'potato'
  AND t.lyricsSource = 'lrclib'
MATCH (r:Release)-[:HAS_TRACK]->(t)
WITH t, r, score,
     [line IN split(t.lyrics, '\n') WHERE toLower(line) CONTAINS 'potato'][0..2] AS potatoLines
WITH t.title AS song,
     r.title AS album,
     collect(DISTINCT [(r)-[:RELEASED_BY]->(a) | a.name]) AS artistLists,
     potatoLines,
     max(score) AS topScore
WITH song, album,
     apoc.coll.toSet(reduce(acc=[], x IN artistLists | acc + x)) AS artists,
     potatoLines, topScore
RETURN song,
       album,
       artists,
       potatoLines AS lyricsContext,
       topScore    AS score
ORDER BY score DESC
```

> **Confirmed clean matches (lrclib):**
>
> - "Let's Dance" — Ramones → _"We'll do the twist, the stomp, the mashed potato too"_
> - "There Was A Time" — James Brown → _"They call it the Mashed Potato"_
> - "Wild Wild Life" — Talking Heads → _"I ride a hot potato"_
> - "Bomb" — Madlib & Freddie Gibbs → _"split your potato"_
> - "Ch-Check It Out" — Beastie Boys → _"some hot potato"_

---

## 3. All tracks longer than 12 minutes, grouped by writing credits

Tracks grouped by first-listed writer name, then sorted by duration descending within each group.

```cypher
MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
WHERE t.duration IS NOT NULL AND t.duration <> ''
WITH t, r, split(t.duration, ':') AS parts
WHERE size(parts) = 2
WITH t, r,
     toInteger(parts[0]) * 60 + toInteger(parts[1]) AS totalSeconds
WHERE totalSeconds > 720

MATCH (r)-[:RELEASED_BY]->(a:Artist)

OPTIONAL MATCH (m:Musician)-[co:CREDITED_ON]->(t)
WHERE toLower(co.role) CONTAINS 'writ'
   OR toLower(co.role) CONTAINS 'compos'
   OR co.displayRole IN ['Songwriter', 'Music By', 'Lyrics By', 'Lyricon']

WITH t.title    AS track,
     r.title    AS album,
     a.name     AS artist,
     t.duration AS duration,
     collect(DISTINCT m.name) AS writers,
     totalSeconds

WITH track, album, artist, duration, writers, totalSeconds,
     CASE WHEN size(writers) > 0 THEN writers[0]
          ELSE 'zzz_No Writing Credit'
     END AS sortKey

ORDER BY sortKey, totalSeconds DESC
RETURN track, album, artist, duration, writers
```

> **Results:** Autobahn (Kraftwerk, 22:30 — no credit), Iberia (Claude Debussy, 19:50),
> The Clearing (Snarky Puppy, 19:23 — no credit), Do What You Like (Blind Faith, 15:20 — Ginger Baker),
> Take A Pebble (ELP, 12:32 — Greg Lake)

---

## 4. What collaborator is seen across the most genres?

Returns the top musicians by genre/style span. Excludes non-musical roles (management, photography, etc.)
and requires at least 2 distinct releases to filter out Various Artists compilation noise.
Includes the linked Artist node name when the musician also has an Artist credit,
and a list of the releases they appear on.

Includes both track-level and release-level credits (`CREDITED_ON` to `Track` or `Release`) so
composer credits that exist only at release scope are not skipped.
Also returns a deduplicated list of credited roles per musician.

```cypher
MATCH (m:Musician)-[co:CREDITED_ON]->(target)
WHERE (target:Track OR target:Release)
  AND NOT coalesce(toLower(co.role), '') CONTAINS 'manag'
  AND NOT coalesce(toLower(co.role), '') CONTAINS 'photog'
  AND NOT coalesce(toLower(co.role), '') CONTAINS 'artwork'
  AND NOT coalesce(toLower(co.role), '') CONTAINS 'design'
  AND NOT coalesce(toLower(co.role), '') CONTAINS 'sleeve'
  AND NOT coalesce(toLower(co.role), '') CONTAINS 'liner'
  AND NOT coalesce(toLower(co.role), '') CONTAINS 'research'
  AND NOT coalesce(toLower(co.role), '') CONTAINS 'remaster'

OPTIONAL MATCH (rFromTrack:Release)-[:HAS_TRACK]->(target)
WITH m, co, target,
     CASE WHEN target:Release THEN target ELSE rFromTrack END AS r,
     CASE
       WHEN co.displayRole IS NOT NULL AND trim(co.displayRole) <> '' THEN co.displayRole
       WHEN co.role IS NOT NULL AND trim(co.role) <> '' THEN co.role
       ELSE NULL
     END AS roleLabel
WHERE r IS NOT NULL

OPTIONAL MATCH (r)-[:IN_GENRE]->(g:Genre)
OPTIONAL MATCH (r)-[:IN_STYLE]->(s:Style)

WITH m,
     collect(DISTINCT r.discogsId) AS releaseIds,
  collect(DISTINCT {id: r.discogsId, title: r.title, year: r.year}) AS releaseRefs,
     collect(DISTINCT g.name)      AS genres,
  collect(DISTINCT s.name)      AS styles,
  collect(DISTINCT roleLabel)   AS rawRoles

WITH m, releaseIds, releaseRefs,
  apoc.coll.toSet([x IN (genres + styles) WHERE x IS NOT NULL]) AS genreStyles,
  apoc.coll.sort([x IN rawRoles WHERE x IS NOT NULL]) AS roles

UNWIND releaseRefs AS rr
WITH m, releaseIds, genreStyles, roles, rr
ORDER BY coalesce(rr.year, 0), rr.title
WITH m, releaseIds, genreStyles, roles, collect(rr) AS releases

WHERE size(genreStyles) > 1 AND size(releaseIds) > 1

OPTIONAL MATCH (m)-[:SAME_PERSON_AS]->(a:Artist)

RETURN m.name         AS musician,
       a.name         AS alsoKnownAsArtist,
    size(genreStyles) AS genreStyleCount,
       size(releaseIds) AS releaseCount,
    genreStyles,
    roles,
       releases
ORDER BY genreStyleCount DESC, releaseCount DESC
LIMIT 10
```

> **Top results:** Wayne Shorter (Jazz, Pop, Rock, Electronic — 2 releases),
> David T. Walker (Funk/Soul, Classical, Pop, Rock — 3 releases),
> Lennon-McCartney (Rock, Jazz, Funk/Soul — 4 releases as songwriting credits on covers)

---

## 5. What artist has the longest gap between record releases?

Returns the largest consecutive year gap between any two releases in the collection.
Includes the full list of release titles and years.

> **⚠ Reissue caveat:** Release years reflect the pressing in the collection, not the
> original release date. Jackson Browne's "Late For The Sky" (1974) is held as the
> 2017 reissue, inflating his gap to 37 years. The `masterDiscogsId` field exists on
> Release nodes to identify originals, but `originalYear` is not yet enriched from
> the Discogs master release API — that's a future data task.

```cypher
MATCH (a:Artist)<-[:RELEASED_BY]-(r:Release)
WHERE r.year IS NOT NULL AND r.year > 0
WITH a, r ORDER BY a.name, r.year
WITH a,
     collect(DISTINCT toInteger(r.year))              AS years,
     collect(DISTINCT toInteger(r.year) + '|' + r.title) AS yearTitles
WHERE size(years) > 1
WITH a, apoc.coll.sort(years) AS sortedYears, yearTitles
WITH a, sortedYears, yearTitles,
     reduce(maxGap = 0, i IN range(0, size(sortedYears)-2) |
       CASE WHEN toInteger(sortedYears[i+1]) - toInteger(sortedYears[i]) > maxGap
            THEN toInteger(sortedYears[i+1]) - toInteger(sortedYears[i])
            ELSE maxGap END
     ) AS maxGap
RETURN a.name   AS artist,
       maxGap   AS largestGapYears,
       apoc.coll.sort(yearTitles) AS releases
ORDER BY maxGap DESC
LIMIT 10
```

> **Results (may include reissue inflation):**
>
> - Jackson Browne: 37 years (1980 → 2017†)
> - Prince: 30 years (1989 → 2019)
> - Joni Mitchell: 29 years (1968 → 2014, with stops in '71, '74, '85)
> - Talking Heads: 27 years (1986 → 2013)
>
> _† "Late For The Sky" is a 2017 reissue of the 1974 original — see reissue caveat above._

---

## 6. All records grouped by genre, in order of release date

### 6a. Full list — every release sorted within each genre

```cypher
MATCH (r:Release)-[:IN_GENRE]->(g:Genre)
WHERE r.year IS NOT NULL AND r.year > 0
WITH g.name   AS genre,
     r.year   AS year,
     r.title  AS album,
     [(r)-[:RELEASED_BY]->(a) | a.name][0] AS artist
ORDER BY genre, year
RETURN genre, year, album, artist
```

### 6b. Genre summary — one row per genre with counts

```cypher
MATCH (g:Genre)<-[:IN_GENRE]-(r:Release)
MATCH (r)-[:RELEASED_BY]->(a:Artist)
MATCH (r)-[:HAS_TRACK]->(t:Track)
WITH g.name AS genre,
     count(DISTINCT r.discogsId) AS releases,
     count(DISTINCT a.discogsId) AS artists,
     count(DISTINCT t)           AS tracks
RETURN genre, releases, artists, tracks
ORDER BY releases DESC
```

> **Snapshot:** Rock (131 releases, ~90 artists, ~1300 tracks) dominates.
> Funk/Soul has 35, Pop 32, Folk/World/Country 28, Jazz 24.

---

## 7. Which song has the fewest number of words (but at least 1)?

Filters out known garbage from the Genius scraper (`"N Contributors"` prefix, `[Instrumental]` markers)
before counting non-empty space-separated tokens.

```cypher
MATCH (t:Track)
WHERE t.lyrics IS NOT NULL
  AND trim(t.lyrics) <> ''
  AND NOT toLower(t.lyrics) CONTAINS 'contributor'
  AND NOT toLower(t.lyrics) CONTAINS '[instrumental]'
  AND size(t.lyrics) > 10
WITH t,
     size([w IN split(trim(t.lyrics), ' ') WHERE w <> '']) AS wordCount
WHERE wordCount >= 1
MATCH (r:Release)-[:HAS_TRACK]->(t)
MATCH (r)-[:RELEASED_BY]->(a:Artist)
RETURN t.title  AS track,
       a.name   AS artist,
       r.title  AS album,
       wordCount,
       t.lyrics AS fullLyrics
ORDER BY wordCount ASC
LIMIT 5
```

> **Winner: "How I Feel" — Thundercat (It Is What It Is) — 9 words**
> _"How I feel / Is this real? / Is this real? / Is this real?"_
>
> Runner-up: "Se A Cabo" — Santana — 11 words (title phrase repeated 5×)
>
> _Note: results will improve significantly once Genius lyrics are re-enriched (see issue #31)._

### 7b. Alternative: fewest distinct words (unique vocabulary)

Counts unique words per track after lowercasing and stripping punctuation.
Useful when repeated phrases would otherwise dominate the shortest-lyrics results.

```cypher
MATCH (t:Track)
WHERE t.lyrics IS NOT NULL
  AND trim(t.lyrics) <> ''
  AND NOT toLower(t.lyrics) CONTAINS 'contributor'
  AND NOT toLower(t.lyrics) CONTAINS '[instrumental]'
  AND size(t.lyrics) > 10

WITH t,
     [w IN split(
       apoc.text.regreplace(toLower(t.lyrics), "[^a-z0-9' ]", ' '),
       ' '
     ) WHERE w <> ''] AS tokens

WITH t,
     apoc.coll.toSet(tokens) AS uniqueWords

WITH t,
     size(uniqueWords) AS distinctWordCount,
     uniqueWords
WHERE distinctWordCount >= 1

MATCH (r:Release)-[:HAS_TRACK]->(t)
MATCH (r)-[:RELEASED_BY]->(a:Artist)
RETURN t.title  AS track,
       a.name   AS artist,
       r.title  AS album,
       distinctWordCount,
       uniqueWords[0..25] AS sampleUniqueWords,
       t.lyrics AS fullLyrics
ORDER BY distinctWordCount ASC
LIMIT 5
```

---

## 8. Any album covers with naked ladies in them?

The graph can't analyze images. This query exports every album with its cover thumbnail URL
and Discogs page link so you can paste the list to an LLM and ask it to flag known
provocative covers based on its training data.

```cypher
MATCH (r:Release)-[:RELEASED_BY]->(a:Artist)
WHERE r.thumbUrl IS NOT NULL
OPTIONAL MATCH (r)-[:IN_GENRE]->(g:Genre)
WITH r, a, collect(g.name) AS genres
RETURN r.title       AS album,
       a.name        AS artist,
       r.year        AS year,
       r.thumbUrl    AS coverThumbnail,
       r.discogsUrl  AS discogsPage,
       genres,
       r.notes       AS notes
ORDER BY r.year
```

> **Prompt for LLM review:**
> _"Here is a list of vinyl albums from a personal collection. Based on your knowledge,
> flag any whose cover art is known to feature nudity, near-nudity, or explicit imagery.
> Include the album name, artist, and a one-line description of the cover."_

---

## 9. What song has the most versions in the collection?

Normalizes track titles by stripping trailing parenthetical suffixes
(`(Remix)`, `(Live)`, `(Alternate Take)`, etc.) and groups across distinct albums —
a different master release ID counts as a different version.
Covers (same title, different artist) are included.

This version preserves repeated appearances on the same release (for example, album cut + remix)
by keeping each track occurrence via `position` and `releaseId`.

```cypher
MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
MATCH (r)-[:RELEASED_BY]->(a:Artist)

// Strip parenthetical suffixes to find the base song title
WITH t, r, a,
     trim(toLower(
       apoc.text.regreplace(t.title, '\s*\([^)]*\)\s*$', '')
     )) AS baseTitle

WITH baseTitle,
     collect({
       fullTitle : t.title,
  position  : t.position,
  releaseId : toInteger(r.discogsId),
       release   : r.title,
       artist    : a.name,
       year      : toInteger(r.year),
       masterId  : toInteger(r.masterDiscogsId)
     }) AS versions

// Count distinct albums (masterId when available, else releaseId)
WITH baseTitle, versions,
     size(apoc.coll.toSet([v IN versions |
       CASE WHEN v.masterId IS NOT NULL THEN toString(v.masterId)
       ELSE toString(v.releaseId)
       END
     ])) AS distinctAlbumCount,
     size(apoc.coll.toSet([v IN versions | toLower(v.fullTitle)])) AS distinctTitleCount

WHERE distinctTitleCount > 1 OR size(versions) > 1

RETURN baseTitle          AS baseSongTitle,
  distinctTitleCount AS variantCount,
       distinctAlbumCount AS albumVersionCount,
       size(versions)     AS totalAppearances,
       versions
ORDER BY variantCount DESC, totalAppearances DESC, albumVersionCount DESC
LIMIT 15
```

> **Top results:**
>
> - **"Just Like A Woman"** — 3 distinct albums: Bob Dylan's Greatest Hits (1967),
>   Before The Flood — Dylan/The Band live (1974), Joe Cocker cover (1969)
> - **"I Shall Be Released"** — 2 albums: Joe Cocker cover (1969), Dylan/Band live (1974)
> - **"Nobody Knows You When You're Down And Out"** — 2 albums: Nina Simone (1966),
>   Tedeschi Trucks / Anastasio cover (2021)
> - **"Tiger Mountain Peasant Song"** — 2 albums: Fleet Foxes debut (2013),
>   A Very Lonely Solstice acoustic (2022)

---

## 10. Which song has the most international reach by number of countries?

Groups track titles across all releases and counts distinct countries of manufacture.
Because songs appear on one release each (which has one country), international reach
means the same title was pressed in different markets — as a cover, a different pressing,
or a same-artist re-release. Both same-artist variants and cross-artist covers qualify.

> **Data note:** With 196 releases across 12 country codes, the max reach per title is 2.
> The country field reflects the **pressing country** (where the vinyl was manufactured),
> not the artist's nationality.

```cypher
MATCH (t:Track)<-[:HAS_TRACK]-(r:Release)-[:FROM_COUNTRY]->(c:Country)
MATCH (r)-[:RELEASED_BY]->(a:Artist)
WITH toLower(trim(t.title)) AS baseTitle,
     t.title                AS displayTitle,
     collect(DISTINCT c.name)  AS countries,
     collect(DISTINCT a.name)  AS artists
WHERE size(countries) > 1
RETURN displayTitle AS song,
       size(countries) AS countryCount,
       countries,
       artists
ORDER BY countryCount DESC, displayTitle
```

> **Top results (all tied at 2 countries):**
>
> - "Nobody Knows You When You're Down And Out" — Nina Simone (Europe) + Trey Anastasio / Tedeschi Trucks Band (US) — _widest geographic spread + covers a classic blues standard_
> - "Shame" — Freddie Gibbs/Madlib (US) + White Denim (UK & Europe)
> - "Let's Dance" — Ramones (US) + David Bowie (UK)
> - "Heroes" — Commodores (US) + David Bowie (UK)

---

## 11. Which record has the longest track names?

Two angles: the single longest track name in the collection, and the album with the
highest average track name length (minimum 5 tracks to avoid 2-track EPs skewing).

### 11a. Single longest track name

```cypher
MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
MATCH (r)-[:RELEASED_BY]->(a:Artist)
RETURN t.title     AS track,
       r.title     AS album,
       a.name      AS artist,
       size(t.title) AS chars
ORDER BY chars DESC
LIMIT 10
```

> **Winner: ELP — "When The Apple Blossoms Bloom In The Windmills Of Your Mind I'll Be Your Valentine"**
> 82 characters, from _Works (Volume 2)_ (1977)
>
> Runner-up: Carly Simon — "This Is My Life Suite: A) Pleasure And Pain, B) Coming Home, C) Uncle Peter" (75 chars)
> Third: Terry Allen — "There Oughta Be A Law Against Sunny Southern California (Jabo I, II, III)" (74 chars)

### 11b. Album with highest average track name length (5+ tracks)

```cypher
MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
MATCH (r)-[:RELEASED_BY]->(a:Artist)
WITH r, a,
     collect(t.title)      AS titles,
     count(t)              AS trackCount,
     sum(size(t.title))    AS totalChars,
     max(size(t.title))    AS longestTitle
WHERE trackCount >= 5
WITH r, a, titles, trackCount, totalChars, longestTitle,
     round(toFloat(totalChars) / trackCount) AS avgChars
RETURN r.title     AS album,
       a.name      AS artist,
       avgChars,
       longestTitle AS longestTitleChars,
       trackCount,
       titles[0..4] AS sampleTitles
ORDER BY avgChars DESC
LIMIT 10
```

> **Winner: Juarez — Terry Allen** (avg 26 chars/title across 15 tracks, with one 74-char monster)
> Followed by Father John Misty's _I Love You, Honeybear_ — "Nothing Good Ever Happens At The Goddamn Thirsty Crow" sets the tone.

---

## 12. Return all albums with a car on the cover (not by The Cars)

The graph can't analyze images, so this exports every cover thumbnail with its
Discogs page for LLM review. The Cars are filtered out; they are not currently in
the collection, but the exclusion is included for correctness.

```cypher
MATCH (r:Release)-[:RELEASED_BY]->(a:Artist)
WHERE r.thumbUrl IS NOT NULL
  AND NOT a.name IN ['The Cars', 'Cars']
OPTIONAL MATCH (r)-[:IN_GENRE]->(g:Genre)
WITH r, a, collect(g.name) AS genres
RETURN r.title      AS album,
       a.name       AS artist,
       r.year       AS year,
       r.thumbUrl   AS coverThumbnail,
       r.discogsUrl AS discogsPage,
       genres
ORDER BY r.year
```

> **Prompt for LLM review:**
> _"Here is a list of vinyl albums with their cover art URLs. Based on your knowledge of
> these albums, flag any whose cover art prominently features a car or automobile.
> Include the album name, artist, and a one-line description of what's on the cover."_

---

## 13. Which original song has the most remixes?

Groups tracks by their base title (parenthetical suffixes stripped) and counts how many
distinct title variants exist — `(Radio Mix)`, `(Beatminerz Remix)`, `(Acoustic)`,
`(Alternate Version)`, etc.

```cypher
MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
MATCH (r)-[:RELEASED_BY]->(a:Artist)

// Strip trailing parenthetical to get the base song title
WITH t, r, a,
     trim(toLower(apoc.text.regreplace(t.title, '\s*\([^)]*\)\s*$', ''))) AS baseTitle

WITH baseTitle,
     collect(DISTINCT {
       fullTitle : t.title,
       release   : r.title,
       artist    : a.name,
       year      : toInteger(r.year)
     }) AS allVersions,
     size(apoc.coll.toSet([v IN
       collect(DISTINCT {
         fullTitle : t.title,
         release   : r.title,
         artist    : a.name,
         year      : toInteger(r.year)
       }) | toLower(v.fullTitle)
     ])) AS distinctTitleCount

WHERE distinctTitleCount > 1

RETURN baseTitle         AS baseSongTitle,
       distinctTitleCount AS variantCount,
       allVersions
ORDER BY variantCount DESC, baseTitle
LIMIT 10
```

> **Winner: "Silent Treatment" — The Roots** — 6 distinct variants on _Do You Want More?!!!??!_ (2021 reissue):
> original + Street Mix, Question's Mix, Black Thought's 87 You And Yours Mix,
> Beatminerz Remix, Kelo's Remix
>
> Runner-up: "Same O Thang" — Da Villon/Tab (4 variants: 12" Full Mix, 12" Instrumental,
> Album Version, Radio Mix)
>
> Also: "Main Street" and "Mr. Cigarette" — Deer Tick (3 variants each on the
> _Divine Providence_ 11th Anniversary Edition)

---

## 14. What's a song written in a 7/8 time signature?

**Time signature metadata is not stored in the Discogs data model** and is not currently
in the graph. This query surfaces releases tagged with styles associated with complex
and odd-meter music — the most likely candidates in the collection.

```cypher
MATCH (r:Release)-[:IN_STYLE]->(s:Style)
WHERE s.name IN ['Prog Rock', 'Jazz-Rock', 'Fusion', 'Contemporary Jazz', 'Experimental']
MATCH (r)-[:RELEASED_BY]->(a:Artist)
MATCH (r)-[:HAS_TRACK]->(t:Track)
WITH s.name AS style,
     a.name AS artist,
     r.title AS album,
     toInteger(r.year) AS year,
     collect(t.title) AS tracks
RETURN style, artist, album, year, tracks
ORDER BY style, year
```

> **Known odd-meter tracks in the collection** (from general music knowledge —
> not queryable from the graph):
>
> | Track                   | Artist              | Album                    | Time Sig               |
> | ----------------------- | ------------------- | ------------------------ | ---------------------- |
> | "Knife-Edge"            | ELP                 | _Emerson, Lake & Palmer_ | 5/4 sections (Janáček) |
> | "The Barbarian"         | ELP                 | _Emerson, Lake & Palmer_ | 5/4 (Bartók)           |
> | "Hoedown"               | ELP                 | _Trilogy_                | 2/4 (Copland)          |
> | "Siberian Khatru"       | Yes                 | _Close To The Edge_      | Mixed/3/8 sections     |
> | "In Your Own Sweet Way" | New Brubeck Quartet | _Live At Montreux_       | 6/4 (Brubeck classic)  |
> | "Summer Music"          | New Brubeck Quartet | _Live At Montreux_       | Likely complex meter   |
>
> For confirmed time signatures, cross-reference with
> [MusicBrainz](https://musicbrainz.org) or [AllMusic](https://www.allmusic.com).

---

## 15. What songs feature slide guitar?

Searches the `CREDITED_ON` relationship `role` field at **track level only** — the most
precise scope, where a musician is credited for a specific track rather than the whole album.

Two Discogs-specific gotchas learned from the actual data:

- `CONTAINS 'slide'` also matches `"Trumpet [Slide]"` (the valve notation for a trombone-style
  slide trumpet). Use `CONTAINS 'slide guitar'` to avoid it.
- Release-level credits (e.g. the pedal steel player credited on the whole of _Blue_)
  expand to every track on the record and flood results with noise. Dropping the
  release-level branch keeps answers to actual specific songs.

```cypher
MATCH (r:Release)-[:HAS_TRACK]->(t:Track)<-[co:CREDITED_ON]-(m:Musician)
WHERE toLower(co.role) CONTAINS 'slide guitar'
   OR toLower(co.role) CONTAINS 'lap steel'
   OR toLower(co.role) CONTAINS 'pedal steel'
   OR toLower(co.role) CONTAINS 'steel guitar'
   OR toLower(co.role) CONTAINS 'dobro'
MATCH (r)-[:RELEASED_BY]->(a:Artist)
WITH t.title    AS song,
     r.title    AS album,
     a.name     AS artist,
     t.duration AS duration,
     collect(DISTINCT m.name + ' — ' + co.role) AS slideCredits
RETURN song, album, artist, duration, slideCredits
ORDER BY album, song
```

> **Answer: "How Do You Sleep?" and "I Don't Want To Be A Soldier"** —
> both on John Lennon's _Imagine_, with George Harrison credited for pure `"Slide Guitar"`
> (not mixed with other instruments in the role string). His slide is the lead melodic
> voice throughout both tracks.
> Jackson Browne's own `"Slide Guitar"` credit on **"The Road And The Sky"** (_Late For The Sky_)
> is the other strong answer.

**Albums where a slide guitarist is credited at the album level** (every track on the record):

```cypher
MATCH (m:Musician)-[co:CREDITED_ON]->(r:Release)
WHERE toLower(co.role) CONTAINS 'slide guitar'
   OR toLower(co.role) CONTAINS 'lap steel'
   OR toLower(co.role) CONTAINS 'pedal steel'
   OR toLower(co.role) CONTAINS 'steel guitar'
   OR toLower(co.role) CONTAINS 'dobro'
MATCH (r)-[:RELEASED_BY]->(a:Artist)
RETURN a.name AS artist, r.title AS album, toInteger(r.year) AS year,
       collect(DISTINCT m.name + ' — ' + co.role) AS slideCredits
ORDER BY year, album
```

---

## 16. Which songs mention more than two different animals?

Checks each track's lyrics (lrclib only — Genius data is corrupted) against a curated
list of ~70 animal species. Each animal has a canonical name and a word-boundary regex
that handles regular plurals (dogs, cats) and common irregular plurals (mice, wolves,
geese, flies, ponies).

Words with dual meanings — `bear` (verb), `fly` (verb), `dove` (past tense of dive),
`bat` (sports), `cricket` (sport) — may produce false positives; unavoidable without NLP.

Results are sorted by distinct animal count descending.

```cypher
WITH [
  // Mammals
  {name:'dog',         pattern:'\\bdogs?\\b'},
  {name:'cat',         pattern:'\\bcats?\\b'},
  {name:'horse',       pattern:'\\bhorses?\\b'},
  {name:'cow',         pattern:'\\bcows?\\b'},
  {name:'pig',         pattern:'\\bpigs?\\b'},
  {name:'sheep',       pattern:'\\bsheep\\b'},
  {name:'lamb',        pattern:'\\blambs?\\b'},
  {name:'goat',        pattern:'\\bgoats?\\b'},
  {name:'bull',        pattern:'\\bbulls?\\b'},
  {name:'wolf',        pattern:'\\b(?:wolf|wolves)\\b'},
  {name:'fox',         pattern:'\\bfoxes?\\b'},
  {name:'bear',        pattern:'\\bbears?\\b'},
  {name:'deer',        pattern:'\\bdeer\\b'},
  {name:'rabbit',      pattern:'\\brabbits?\\b'},
  {name:'hare',        pattern:'\\bhares?\\b'},
  {name:'mouse',       pattern:'\\b(?:mouse|mice)\\b'},
  {name:'rat',         pattern:'\\brats?\\b'},
  {name:'bat',         pattern:'\\bbats?\\b'},
  {name:'whale',       pattern:'\\bwhales?\\b'},
  {name:'dolphin',     pattern:'\\bdolphins?\\b'},
  {name:'seal',        pattern:'\\bseals?\\b'},
  {name:'lion',        pattern:'\\blions?\\b'},
  {name:'tiger',       pattern:'\\btigers?\\b'},
  {name:'elephant',    pattern:'\\belephants?\\b'},
  {name:'monkey',      pattern:'\\bmonkeys?\\b'},
  {name:'donkey',      pattern:'\\bdonkeys?\\b'},
  {name:'mule',        pattern:'\\bmules?\\b'},
  {name:'hound',       pattern:'\\bhounds?\\b'},
  {name:'pony',        pattern:'\\bpon(?:y|ies)\\b'},
  {name:'coyote',      pattern:'\\bcoyotes?\\b'},
  {name:'raccoon',     pattern:'\\braccoons?\\b'},
  {name:'skunk',       pattern:'\\bskunks?\\b'},
  {name:'beaver',      pattern:'\\bbeavers?\\b'},
  {name:'otter',       pattern:'\\botters?\\b'},
  // Reptiles & amphibians
  {name:'snake',       pattern:'\\bsnakes?\\b'},
  {name:'frog',        pattern:'\\bfrogs?\\b'},
  {name:'toad',        pattern:'\\btoads?\\b'},
  {name:'turtle',      pattern:'\\bturtles?\\b'},
  {name:'alligator',   pattern:'\\balligators?\\b'},
  {name:'crocodile',   pattern:'\\bcrocodiles?\\b'},
  // Fish & sea creatures
  {name:'shark',       pattern:'\\bsharks?\\b'},
  {name:'salmon',      pattern:'\\bsalmon\\b'},
  {name:'eel',         pattern:'\\beels?\\b'},
  {name:'crab',        pattern:'\\bcrabs?\\b'},
  // Birds
  {name:'bird',        pattern:'\\bbirds?\\b'},
  {name:'robin',       pattern:'\\brobins?\\b'},
  {name:'sparrow',     pattern:'\\bsparrows?\\b'},
  {name:'crow',        pattern:'\\bcrows?\\b'},
  {name:'raven',       pattern:'\\bravens?\\b'},
  {name:'eagle',       pattern:'\\beagles?\\b'},
  {name:'hawk',        pattern:'\\bhawks?\\b'},
  {name:'dove',        pattern:'\\bdoves?\\b'},
  {name:'swan',        pattern:'\\bswans?\\b'},
  {name:'duck',        pattern:'\\bducks?\\b'},
  {name:'goose',       pattern:'\\b(?:goose|geese)\\b'},
  {name:'owl',         pattern:'\\bowls?\\b'},
  {name:'jay',         pattern:'\\bjays?\\b'},
  {name:'mockingbird', pattern:'\\bmockingbirds?\\b'},
  {name:'nightingale', pattern:'\\bnightingales?\\b'},
  {name:'peacock',     pattern:'\\bpeacocks?\\b'},
  {name:'parrot',      pattern:'\\bparrots?\\b'},
  {name:'canary',      pattern:'\\b(?:canary|canaries)\\b'},
  {name:'chicken',     pattern:'\\bchickens?\\b'},
  {name:'rooster',     pattern:'\\broosters?\\b'},
  {name:'hen',         pattern:'\\bhens?\\b'},
  {name:'turkey',      pattern:'\\bturkeys?\\b'},
  {name:'pigeon',      pattern:'\\bpigeons?\\b'},
  {name:'falcon',      pattern:'\\bfalcons?\\b'},
  {name:'vulture',     pattern:'\\bvultures?\\b'},
  {name:'wren',        pattern:'\\bwrens?\\b'},
  {name:'finch',       pattern:'\\bfinches?\\b'},
  {name:'bluebird',    pattern:'\\bbluebirds?\\b'},
  // Insects & invertebrates
  {name:'bee',         pattern:'\\bbees?\\b'},
  {name:'ant',         pattern:'\\bants?\\b'},
  {name:'fly',         pattern:'\\b(?:fly|flies)\\b'},
  {name:'butterfly',   pattern:'\\bbutterfl(?:y|ies)\\b'},
  {name:'moth',        pattern:'\\bmoths?\\b'},
  {name:'firefly',     pattern:'\\bfirefl(?:y|ies)\\b'},
  {name:'cricket',     pattern:'\\bcrickets?\\b'},
  {name:'beetle',      pattern:'\\bbeetles?\\b'},
  {name:'spider',      pattern:'\\bspiders?\\b'},
  {name:'worm',        pattern:'\\bworms?\\b'},
  {name:'caterpillar', pattern:'\\bcaterpillars?\\b'}
] AS animalDefs

MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
WHERE t.lyrics IS NOT NULL AND t.lyricsSource = 'lrclib'

WITH t, r, animalDefs,
     [def IN animalDefs
      WHERE toLower(t.lyrics) =~ ('(?is).*' + def.pattern + '.*')
     ] AS matchedAnimals

WHERE size(matchedAnimals) > 2

MATCH (r)-[:RELEASED_BY]->(a:Artist)

RETURN t.title               AS song,
       r.title               AS album,
       a.name                AS artist,
       size(matchedAnimals)  AS animalCount,
       [def IN matchedAnimals | def.name] AS animals
ORDER BY animalCount DESC, song
LIMIT 20
```

---

## 17. What rock album from the 60s has the same B-side length as a pop album from the 90s?

"B-side length" = total duration of all tracks whose `position` starts with `'B'`
(i.e., B1, B2, B3 … on a standard LP side B). Tracks with missing or un-parseable
durations are excluded from the sum.

Two `CALL {}` subqueries compute B-side totals independently for each genre/decade
combination, then are joined as a Cartesian product and filtered for exact matches.
With 196 releases the exact-second version may return nothing — the fuzzy variant
(± 30 seconds) is included below.

> **Note on decade classification:** `RECORDED_IN_DECADE` is derived from `r.year`
> (the pressing year), not `originalYear`. A 1969 reissue pressed in 1978 will be
> classified as 1970s, not 1960s. Gap B1 tracks this.

```cypher
// B-side total (seconds) for every Rock release from the 1960s
CALL {
  MATCH (r:Release)-[:IN_GENRE]->(g:Genre {name: 'Rock'})
  MATCH (r)-[:RECORDED_IN_DECADE]->(d:Decade {name: '1960s'})
  MATCH (r)-[:HAS_TRACK]->(t:Track)
  WHERE t.position STARTS WITH 'B'
    AND t.duration IS NOT NULL
    AND size(split(t.duration, ':')) = 2
  WITH r,
       sum(toInteger(split(t.duration, ':')[0]) * 60 +
           toInteger(split(t.duration, ':')[1])) AS bSideSecs
  WHERE bSideSecs > 0
  RETURN r AS rockR, bSideSecs AS rockSecs
}

// B-side total (seconds) for every Pop release from the 1990s
CALL {
  MATCH (r:Release)-[:IN_GENRE]->(g:Genre {name: 'Pop'})
  MATCH (r)-[:RECORDED_IN_DECADE]->(d:Decade {name: '1990s'})
  MATCH (r)-[:HAS_TRACK]->(t:Track)
  WHERE t.position STARTS WITH 'B'
    AND t.duration IS NOT NULL
    AND size(split(t.duration, ':')) = 2
  WITH r,
       sum(toInteger(split(t.duration, ':')[0]) * 60 +
           toInteger(split(t.duration, ':')[1])) AS bSideSecs
  WHERE bSideSecs > 0
  RETURN r AS popR, bSideSecs AS popSecs
}

// Exact match — same B-side to the second
WHERE rockSecs = popSecs

MATCH (rockR)-[:RELEASED_BY]->(rockA:Artist)
MATCH (popR)-[:RELEASED_BY]->(popA:Artist)

RETURN rockA.name  AS rockArtist,
       rockR.title AS rockAlbum,
       popA.name   AS popArtist,
       popR.title  AS popAlbum,
       toString(rockSecs / 60) + ':' +
         apoc.text.lpad(toString(rockSecs % 60), 2, '0') AS sharedBSideLength
ORDER BY rockSecs
```

**Fuzzy variant — within ± 30 seconds** (if exact returns nothing):

```cypher
// ... same CALL {} blocks as above, then:
WHERE abs(rockSecs - popSecs) <= 30

MATCH (rockR)-[:RELEASED_BY]->(rockA:Artist)
MATCH (popR)-[:RELEASED_BY]->(popA:Artist)

RETURN rockA.name  AS rockArtist,
       rockR.title AS rockAlbum,
       toString(rockSecs / 60) + ':' +
         apoc.text.lpad(toString(rockSecs % 60), 2, '0') AS rockBSide,
       popA.name   AS popArtist,
       popR.title  AS popAlbum,
       toString(popSecs / 60) + ':' +
         apoc.text.lpad(toString(popSecs % 60), 2, '0') AS popBSide,
       abs(rockSecs - popSecs)                           AS diffSecs
ORDER BY diffSecs, rockSecs
```

**Diagnostic — see all B-side lengths to calibrate the tolerance:**

```cypher
// Run this first to understand the distribution of B-side lengths in each genre
MATCH (r:Release)-[:IN_GENRE]->(g:Genre)
WHERE g.name IN ['Rock', 'Pop']
MATCH (r)-[:RECORDED_IN_DECADE]->(d:Decade)
WHERE d.name IN ['1960s', '1990s']
MATCH (r)-[:HAS_TRACK]->(t:Track)
WHERE t.position STARTS WITH 'B'
  AND t.duration IS NOT NULL
  AND size(split(t.duration, ':')) = 2
WITH g.name AS genre, d.name AS decade, r,
     sum(toInteger(split(t.duration, ':')[0]) * 60 +
         toInteger(split(t.duration, ':')[1])) AS bSideSecs
WHERE bSideSecs > 0
MATCH (r)-[:RELEASED_BY]->(a:Artist)
RETURN genre, decade, a.name AS artist, r.title AS album,
       toString(bSideSecs / 60) + ':' +
         apoc.text.lpad(toString(bSideSecs % 60), 2, '0') AS bSideLength,
       bSideSecs
ORDER BY genre, decade, bSideSecs
```

---

## 18. Which song has the most international reach by pressing country?

**Current model (pressing geography):** counts distinct Discogs `FROM_COUNTRY` values
across all releases that contain the same song by the same artist. Discogs country codes
are regional strings (`"US"`, `"Europe"`, `"UK & Europe"`, `"USA & Canada"`,
`"Worldwide"`), not ISO 3166 — so `"Europe"` counts as one region, not 44 countries.
This is noted as gap F1.

Groups by `(track title, primary album artist)` to match the same recording across
multiple pressings (e.g., the original US release + a later European pressing of the
same album). Tracks that only appear on a single pressing are excluded.

```cypher
MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
MATCH (r)-[:FROM_COUNTRY]->(c:Country)
MATCH (r)-[:RELEASED_BY]->(a:Artist)

WITH t.title   AS song,
     a.name    AS artist,
     collect(DISTINCT c.name)  AS pressingRegions,
     collect(DISTINCT r.title) AS releasedOn

WHERE size(pressingRegions) > 1

RETURN song,
       artist,
       size(pressingRegions) AS regionCount,
       pressingRegions,
       releasedOn
ORDER BY regionCount DESC, song
LIMIT 20
```

> **Expanding this query:** once sales, chart, or radio-play data is available,
> replace the `FROM_COUNTRY` count with the richer signal. The query structure
> stays the same — swap the `pressingRegions` aggregation for the new metric.

---

## 19. Which song has the most international team of credited musicians?

> **Data not yet available — gap B3.**
>
> This query requires `artistCountry` (or `nationality`) on Musician/Artist nodes,
> which is not currently stored. Discogs artist profiles sometimes include a country
> field; fetching it for all credited musicians would enable:

```cypher
// Sketch — requires gap B3 to be resolved first
MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
MATCH (m:Musician)-[co:CREDITED_ON]->(t)
WHERE co.roleCategory IN ['performer', 'composer']  // requires gap A3
  AND m.nationality IS NOT NULL                      // requires gap B3

WITH t.title AS song, r.title AS album,
     collect(DISTINCT m.nationality) AS nationalities,
     collect(DISTINCT {musician: m.name, country: m.nationality}) AS credits

WHERE size(nationalities) > 1

MATCH (r)-[:RELEASED_BY]->(a:Artist)

RETURN song, album, a.name AS artist,
       size(nationalities) AS countryCount,
       nationalities,
       credits
ORDER BY countryCount DESC
LIMIT 20
```

> **To enable:** resolve gap B3 (fetch `GET /artists/{discogsId}` and store `nationality`)
> and gap A3 (`roleCategory` on `CREDITED_ON` to exclude non-musical credits).
> Both are medium-effort ingestion-side changes.
