# Marketing files

## Current printable brochures

- `../pdf/campusride-trifold-print.pdf` — drivers, six panels across two sides.
- `../pdf/hostelfinder-trifold-print.pdf` — landlords, six panels across two sides.
- `../pdf/PRINT-INSTRUCTIONS.txt` — bleed, folding and printing guidance.

## Source files

- `build_print_brochures.py` — editable layout and copy for both brochures.
- `assets/` — original cover artwork and recorded UI images required by the builder. Cover images are source artwork cropped during PDF generation, not current brochure previews.
- `qr/` — reusable console and student QR assets. The PDF builder generates its own vector console QR.
- `campaigns/` — separate student promotion and ambassador designs, with their prompts.

The builder also uses the existing `public/logo-watermark.png` brand asset.
Run from the repository root with a Python environment containing ReportLab and Pillow:

```sh
python3 output/marketing/build_print_brochures.py
```

This overwrites the two current PDFs. Render and visually review both sides after layout changes. Superseded brochure drafts and unused screencast frames have been removed.
