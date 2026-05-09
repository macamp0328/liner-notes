# Social Queries

Cypher queries for relationship-driven analysis of the vinyl collection.
Run these in the Neo4j browser or via `cypher-shell`.

---

## Q1 — Artists with the most releases in the collection

```cypher
MATCH (a:Artist)<-[:RELEASED_BY]-(r:Release)
RETURN a.name AS artist, count(r) AS releases
ORDER BY releases DESC
LIMIT 10
```

---

## Q2 — Most-represented genres

```cypher
MATCH (r:Release)-[:IN_GENRE]->(g:Genre)
RETURN g.name AS genre, count(r) AS releases
ORDER BY releases DESC
```

---

## Q3 — Session musicians appearing across the most releases

```cypher
MATCH (m:Musician)-[:CREDITED_ON]->(r:Release)
RETURN m.name AS musician, count(DISTINCT r) AS releases
ORDER BY releases DESC
LIMIT 20
```

---

## Q4 — Releases per decade

```cypher
MATCH (r:Release)-[:RECORDED_IN_DECADE]->(d:Decade)
RETURN d.name AS decade, count(r) AS releases
ORDER BY decade ASC
```

---

## Q5 — Largest gap between consecutive releases by the same artist

Uses `coalesce(r.originalYear, r.pressingYear)` so that reissues and
remasters use the album's original release year rather than the pressing
year, which can be decades later.

```cypher
MATCH (a:Artist)<-[:RELEASED_BY]-(r:Release)
WHERE coalesce(r.originalYear, r.pressingYear) IS NOT NULL
WITH a, coalesce(r.originalYear, r.pressingYear) AS effectiveYear, r.title AS title
ORDER BY a.name, effectiveYear
WITH a,
     collect(DISTINCT toInteger(effectiveYear)) AS years,
     collect(DISTINCT toString(toInteger(effectiveYear)) + '|' + title) AS yearTitles
WHERE size(years) > 1
WITH a, years, yearTitles,
     [i IN range(0, size(years)-2) | years[i+1] - years[i]] AS gaps
WITH a, gaps, reduce(maxGap = 0, g IN gaps | CASE WHEN g > maxGap THEN g ELSE maxGap END) AS largestGap
ORDER BY largestGap DESC
RETURN a.name AS artist, largestGap
LIMIT 10
```

---

## Q6 — Release pairs sharing session musicians

```cypher
MATCH (m:Musician)-[:CREDITED_ON]->(r1:Release),
      (m)-[:CREDITED_ON]->(r2:Release)
WHERE id(r1) < id(r2)
WITH r1, r2, collect(m.name) AS sharedMusicians
WHERE size(sharedMusicians) >= 2
RETURN r1.title AS release1, r2.title AS release2,
       sharedMusicians, size(sharedMusicians) AS count
ORDER BY count DESC
LIMIT 10
```

---

## Q7 — Studios with the most recorded releases

```cypher
MATCH (r:Release)-[:RECORDED_AT]->(s:Studio)
RETURN s.name AS studio, count(r) AS releases
ORDER BY releases DESC
LIMIT 10
```
