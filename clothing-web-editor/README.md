# Clothing web editor (static)

## What it does
- Pick a color from the palette
- Draw on the clothes (drawing is limited to the white “garment” rectangles)
- Undo (top-right icon)
- Save result → downloads a PNG screenshot of the tool

## Add your model photos
Put your images here (PNG recommended):
- `assets/model-left.png`
- `assets/model-center.png`
- `assets/model-right.png`

If an image is missing, the app will show a placeholder.

## Run locally
From the `clothing-web-editor` folder:

```bash
python3 -m http.server 5173
```

Then open:
- `http://localhost:5173/`

## Adjust drawing areas (clothing rectangles)
In `index.html`, each `.model` has `data-garment="x,y,w,h"` where values are **percentages from 0 to 1**:

Example:
- `data-garment="0.24,0.18,0.52,0.68"`

