# Bike Walk Joplin — Community Safety Map

Community-powered bike and pedestrian safety map for Joplin, MO. Built with Leaflet.js + OpenStreetMap, live data from JATSO/ArcGIS, hosted on GitHub Pages.

## Features

- Live JATSO data (point reports, route suggestions, existing bike facilities) via ArcGIS REST API
- Community reporting with click-to-place pin, multi-step form, photo upload
- Schools layer with 1-mile walkable zone circles (OpenStreetMap / Overpass API)
- Toggleable layers with live stat counters
- Fully responsive — mobile slide-up panel, desktop slide-in panel

## Setup

### 1. Wire up Google Form submissions

Edit `app.js` → `GOOGLE_FORM`:

1. Open your Google Form in edit mode
2. Click ⋮ → **Get pre-filled link**, fill dummy values, copy the URL
3. Extract `entry.XXXXXXX` field IDs from the URL parameters
4. Set `action` to your form's POST URL (visible in the form page source as `action=""`)
5. Map each `entry.XXXXXXX` to the corresponding field key

### 2. Confirm ArcGIS bike infrastructure URL

The `bikeInfra` URL in `DATA_SOURCES` may need its org ID updated. To find it:
- Open the [JATSO reporter app](https://craftontull.maps.arcgis.com/apps/instant/reporter/index.html?appid=f3c3efd9a9a245c7a1979e85354b0586)
- Open browser devtools → Network tab
- Filter by "FeatureServer" — copy the correct URL for JATSO_Bike_Paths layer 4

### 3. Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "init: BWJ community safety map"
gh repo create bike-walk-joplin-map --public --source=. --push
```

Then in the GitHub repo: **Settings → Pages → Deploy from branch → main / root**

The site will be live at `https://[your-username].github.io/bike-walk-joplin-map/`

### 4. Embed in Squarespace

In Squarespace, add a **Code Block** or **Embed Block**:

```html
<iframe
  src="https://[your-username].github.io/bike-walk-joplin-map/"
  width="100%"
  height="600"
  style="border:none; border-radius:8px;"
  loading="lazy"
  title="Bike Walk Joplin Community Safety Map">
</iframe>
```

## Photo uploads

Photos are previewed locally but not uploaded (static site limitation). For production:
- **Cloudinary** — free unsigned upload widget, returns a CDN URL you append to the form submission
- See: https://cloudinary.com/documentation/upload_widget

## Data sharing / API access

See the data sharing section in the project docs. BWJ submission data lives in the linked Google Sheets response spreadsheet and can be shared as:
- Public CSV export URL (read-only, refreshes automatically)
- Google Sheets JSON API (structured, queryable)

JATSO data remains accessible directly via the ArcGIS REST endpoints documented in `app.js`.
