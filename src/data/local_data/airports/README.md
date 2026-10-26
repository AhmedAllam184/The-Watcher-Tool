# Airports

Extracted from OurAirports (`airports.csv`,
https://github.com/davidmegginson/ourairports-data), downloaded 2026-10-26.

Filters: every `large_airport`, plus `medium_airport` rows with
`scheduled_service=yes`. Heliports, seaplane bases, small and closed airfields
are excluded.

Feature count: 3,290 (1,175 large, 2,115 medium with scheduled service).

Fields kept: `name`, `iata`, `icao` (falls back to the GPS code), `kind`
(`Large airport` / `Airport`), `city` (municipality) and `country` (ISO 3166-1
alpha-2).

Runtime output: `airports.geojsonl`

License: OurAirports data is released to the public domain. Credit
"OurAirports" when redistributing.
