# Route Archaeologist

[CoolCode.ca/routearchaeologist](https://coolcode.ca/routearchaeologist/) is a browser explorer for the BGP history of public IP addresses, CIDR prefixes and ASNs. Start with TELUS AS852, Bell Canada AS577 or Vidéotron AS5769, or enter a network and a UTC date range. Choose among the returned prefixes to inspect its origin timeline. The app compares observed origins and visibility and exports the selected prefix's intervals as CSV.

## Build and test

```sh
python3 scripts/build.py
node --test tests/data.test.mjs
python3 -m http.server 8000 --directory dist
```

Open http://localhost:8000/ after starting the server. The build copies the static application to `dist/`. All app assets use relative URLs. Live lookups go directly from the browser to RIPEstat on submission or when following a shared lookup URL. No API key, application server, or scheduled dataset download is required. The UI can also open an original Routing History JSON response saved on your device. Imported files stay in the browser.

## Data and interpretation

Data and methodology: [RIPEstat Routing History](https://stat.ripe.net/docs/data-api/api-endpoints/routing-history.html), based on [RIPE RIS](https://ris.ripe.net/) route collectors. The app requests normalized visibility and shows the number of full-feed peers observing each interval. Different origins may overlap in the sampled record. Missing or low-visibility intervals do not establish that a prefix stopped routing everywhere. For traffic path geography, compare with traceroute measurements. Timestamps are UTC and the response can use collector-aligned time boundaries.

The app requests an API soft limit of 1,500 rows and caches up to eight lookups in memory per open page. Prefer a focused prefix or short date range if the source warns about volume, times out, or rate-limits. Use the exact source request link to inspect RIPEstat's own response. The RIPE NCC's [API usage rules](https://stat.ripe.net/docs/data-api/ripestat-data-api) and [RIPEstat terms](https://www.ripe.net/about-us/legal/ripestat-service-terms-and-conditions/) apply. The explorer is an independent noncommercial demonstration.
