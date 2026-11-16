# Route Archaeologist

[CoolCode.ca/routearchaeologist](https://coolcode.ca/routearchaeologist/) is a browser explorer for the BGP history of public IP addresses, CIDR prefixes and ASNs. Start with TELUS AS852, Bell Canada AS577 or Vidéotron AS5769, or enter a network and a UTC date range. Choose among the returned prefixes to inspect its origin timeline. The app compares observed origins and visibility and exports the selected prefix's intervals as CSV.

Use **Inspect BGP snapshot** to see the recorded origins and AS paths for an IP or prefix. Leave the date blank for the latest snapshot, or supply a date to request midnight UTC. For an ASN, use the latest announced-prefix list to filter IPv4 and IPv6 prefixes and open their path snapshots. **Check current RPKI** opens CoolCode’s RPKI Guard with the selected origin and prefix filled in.

## Build and test

```sh
python3 scripts/build.py
node --test tests/data.test.mjs
python3 -m http.server 8000 --directory dist
```

Open http://localhost:8000/ after starting the server. The build copies the static application to `dist/`. All app assets use relative URLs. Live lookups go directly from the browser to RIPEstat on submission or when following a shared lookup URL. No API key, application server, or scheduled dataset download is required. The UI can also open an original Routing History JSON response saved on your device. Imported files stay in the browser.

## Data and interpretation

The [RIPEstat Routing History](https://stat.ripe.net/docs/data-api/api-endpoints/routing-history.html) endpoint uses [RIPE RIS](https://ris.ripe.net/) route collectors. The app requests normalized visibility and shows the number of full-feed peers observing each interval. If RIPEstat returns a server error, the app retries for peer counts and marks missing percentages as unavailable. Different origins may overlap in the sampled record. Gaps can reflect the collectors’ view or the minimum peer threshold. For traffic path geography, compare with traceroute measurements. Timestamps are UTC and the response can use collector-aligned time boundaries.

[BGP State](https://stat.ripe.net/docs/data-api/api-endpoints/bgp-state.html) identifies routes seen by each collector and peer session. A network may peer with more than one collector, so the session count reflects the samples returned by RIPEstat. [Announced Prefixes](https://stat.ripe.net/docs/data-api/api-endpoints/announced-prefixes.html) describes observations at its latest returned time, filtered by the chosen full-feed peer minimum. RPKI results concern current authorization, including when the selected routing observation is historical.

The app requests an API soft limit of 1,500 rows and caches up to eight lookups in memory per open page. Prefer a focused prefix or short date range if the source warns about volume, times out, or rate-limits. Use the exact source request link to inspect RIPEstat's own response. The RIPE NCC's [API usage rules](https://stat.ripe.net/docs/data-api/ripestat-data-api) and [RIPEstat terms](https://www.ripe.net/about-us/legal/ripestat-service-terms-and-conditions/) apply. The explorer is an independent noncommercial demonstration.
