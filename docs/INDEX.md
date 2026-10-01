# Reference Index

Everything lives flat in `docs/`. One line per file: what it is, what is usable, and which part of
`PHYSICS.md` it feeds. The agent can read PDFs directly, but text extraction mangles equations and
tables, so transcribe any number you use from the **page image**, then copy it into `data/` or `PHYSICS.md`.

## Files present

| File | What it is | Readability | Feeds |
|---|---|---|---|
| `day-2017-...dinghies.pdf` | A. H. Day, "Performance prediction for sailing dinghies", Ocean Engineering 136 (2017). Published version, 13 pages (journal pp. 67-79). PDF page = journal page minus 66. | Text has minor glitches. Equations are mangled in the text layer, so read them from page images. Table 1 and Figs 3-4 render fine. | L2-L6, validation |
| `ilca-class-rules.pdf` | ILCA class rules, 42 pages | Text is clean. Diagram dimensions are only in images. Some rule tables have merged rows (D.4.1, F.5.1). | Boat geometry (rig, boom, board, rudder, sail edges) |
| `PrinciplesYachtDesign.pdf` | Larsson and Eliasson, 350 pages | Scanned, no text layer. Readable only as page images (book page = PDF page minus 16). Run OCR to make it searchable. | L4 resistance, L5 stability |

## Where things are

**Day 2017** (PDF pages):
- Sail coefficients: **Table 1, p3**, "ORC Low Lift mainsail coefficients", indexed by apparent wind angle beta
  (0/7/9/12/28/60/90/120/150/180). There is no CL/CD vs angle-of-attack figure.
- Heel and righting moment: section 4, pp 7-8 (Eq. 18 on p8). Heel decoupling also in section 1.2, pp 1-2.
- Aero drag: sections 2.3-2.5, pp 4-5, breakdown in Fig 12 (p11). Parasitic and crew drag in 2.5.
- Hydro drag: sections 3.2 (p6) and 3.4 (p7), breakdown in Fig 11 (p11).
- Yaw balance: centre of effort on p4, section 3.3 on pp 6-7, results in section 6.3, pp 11-12 (Figs 13-14).
- Laser polar results: section 6.1, pp 8-10. Only Fig 3 is a polar plot and it is **measured** data at 12-12.5 kn.
  VPP results (Figs 4-7) are at 9 and 12 kn. Nothing at 6-8 kn.
- Measured boat mass without sail: 79.5 kg (p8).

**ILCA class rules** (PDF pages):
- Mast: upper max 3600 mm, ILCA 7 lower max 2865 mm (p33), curvature limits p34. Boom max 2740 mm (p34).
- Daggerboard: p28. Rudder: p28, but the drawing is ambiguous about which edge each length is measured along.
- Sail edges: ILCA 7 MKI luff 5130 / leech 5570 / foot 2740 mm (p36). MKII 5105 / 5540 / 2735 mm (p37).
- **Not in the rules:** hull length, beam, hull weight, sail area. The rules defer to the ILCA Build Manual (D.2.3, p25).
  The 965 / 1067 values on p27 are transom fitting positions, not beam.

## Gaps and where numbers come from for now

| Needed | Source for now | Status |
|---|---|---|
| Length overall 4.23 m, waterline 3.81 m, beam 1.37 m, draught 0.787 m, sail area 7.06 m^2 | Public class listings | verify against the ILCA Build Manual if it is available |
| Hull cross-sections | None. Approximate from principal dimensions. | accepted for v1 |
| Polar target at 6-8 kn | None in Day. Use VPP results at 9 kn for shape and upwind speed. | extrapolate |
| Hull depth (freeboard), mast diameter | Web forum measurements, URLs in `src/data/laser.json` `sources` | not in docs/, verify |
| Sail effective span form | ORC VPP Documentation 2023 p54, Eqs. 5.43-5.45 (web PDF, URL in `laser.json`) | factor for a una rig is a TUNING GUESS |
| Delft induced-resistance coefficients (Day Eq. 15), downwash constant a0 (Day p6) | Not in docs/. Eq. 16 used for the board as well; a0 is a TUNING GUESS | missing |

## Data files to create

| File | Contents | Status |
|---|---|---|
| `src/data/sail-coefficients.json` | CL and CDv vs apparent wind angle beta, transcribed from Day Table 1 (p3), read from the 300 dpi page image | done (milestone 1) |
| `src/data/laser.json` | Boat parameters from `PHYSICS.md` section 3 plus everything the sim needs; per-parameter sources in its `sources` block (docs page, web source, or TUNING GUESS) | done (milestone 1) |
| `data/laser-polar-target.csv` | Day VPP results at 9 kn, read from Figs 4-7 (approximate, from plots) | todo, optional |

## Not downloaded

Marchaj, *Aero-Hydrodynamics of Sailing* (source of the older sail data), Fossati, *Aero-Hydrodynamics and the
Performance of Sailing Yachts*, and the NVIDIA *GPU Gems* water chapter for Gerstner waves.

## Housekeeping

- `.DS_Store` is in `.gitignore`.
- Optional: OCR `PrinciplesYachtDesign.pdf` (for example with `ocrmypdf`) so it can be searched.

## Rules for agents

- If a constant is not in a file listed here, do not guess it. Mark `// TUNING GUESS` or ask.
- When you use a number from a PDF, cite the file and page in a code comment.
- Numbers read off a plot are approximate. Say so in the comment.
