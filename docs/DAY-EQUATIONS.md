# Day (2017): equations transcribed from page images

Source: A. H. Day, "Performance prediction for sailing dinghies", Ocean Engineering 136 (2017), PDF page 6
(journal p72), section 3. Transcribed from screenshots and from formulas typed by the user.
**This file overrides the PDF text layer** for the equations below. If code disagrees with this file, re-read the page
image before changing this file. Do not silently "fix" either side.

Status per item: [image] transcribed from a screenshot, [typed] typed by the user from the page.

## Residuary resistance [image]

```
R_rc / (∇_c · ρ · g) =
    a0
  + ( a1 · LCB_fpp / L_wl  +  a2 · C_p  +  a3 · ∇_c^(2/3) / A_w ) · ∇_c^(1/3) / L_wl
  + ( a4 · B_wl / L_wl  +  a5 · LCB_fpp / LCF_fpp  +  a6 · B_wl / T_c  +  a7 · C_m ) · ∇_c^(1/3) / L_wl
```

Coefficients a0..a7 are tabulated against Froude number Fn. They come from another paper, saved as
`bare_hull_resistance.pdf` (Table 2, "coefficients for the polynomial for the untrimmed upright residuary resistance
of the bare hull"). **Verified (milestone 2):** all 104 cells checked against the 300 dpi page image of
`bare_hull_resistance.pdf` PDF page 6; no differences. Copied to `src/data/delft-residuary.json`.
The source's Eq. 1.7 (same page) puts all seven terms in one bracket times ∇c^(1/3)/Lwl; algebraically identical to the
two-bracket form above. The source calls the result Rrh (residual resistance of the bare hull, untrimmed, upright).

| Fn | a0 | a1 | a2 | a3 | a4 | a5 | a6 | a7 |
|---|---|---|---|---|---|---|---|---|
| 0.15 | -0.0005 | 0.0023 | -0.0086 | -0.0015 | 0.0061 | 0.0010 | 0.0001 | 0.0052 |
| 0.20 | -0.0003 | 0.0059 | -0.0064 | 0.0070 | 0.0014 | 0.0013 | 0.0005 | -0.0020 |
| 0.25 | -0.0002 | -0.0156 | 0.0031 | -0.0021 | -0.0070 | 0.0148 | 0.0010 | -0.0043 |
| 0.30 | -0.0009 | 0.0016 | 0.0337 | -0.0285 | -0.0367 | 0.0218 | 0.0015 | -0.0172 |
| 0.35 | -0.0026 | -0.0567 | 0.0446 | -0.1091 | -0.0707 | 0.0914 | 0.0021 | -0.0078 |
| 0.40 | -0.0064 | -0.4034 | -0.1250 | 0.0273 | -0.1341 | 0.3578 | 0.0045 | 0.1115 |
| 0.45 | -0.0218 | -0.5261 | -0.2945 | 0.2485 | -0.2428 | 0.6293 | 0.0081 | 0.2086 |
| 0.50 | -0.0388 | -0.5986 | -0.3038 | 0.6033 | -0.0430 | 0.8332 | 0.0106 | 0.1336 |
| 0.55 | -0.0347 | -0.4764 | -0.2361 | 0.8726 | 0.4219 | 0.8990 | 0.0096 | -0.2272 |
| 0.60 | -0.0361 | 0.0037 | -0.2960 | 0.9661 | 0.6123 | 0.7534 | 0.0100 | -0.3352 |
| 0.65 | 0.0008 | 0.3728 | -0.3667 | 1.3957 | 1.0343 | 0.3230 | 0.0072 | -0.4632 |
| 0.70 | 0.0108 | -0.1238 | -0.2026 | 1.1282 | 1.1836 | 0.4973 | 0.0038 | -0.4477 |
| 0.75 | 0.1023 | 0.7726 | 0.5040 | 1.7867 | 2.1934 | -1.5479 | -0.0115 | -0.0977 |

- Symbol clash: **a0..a7 here are residuary coefficients. They are not the downwash constant a0 below.**
  Use different names in code.
- The table covers Fn 0.15 to 0.75 only. For this boat (Lwl about 3.81 m) Fn 0.15 is roughly 1.8 kn, so a Laser creeping
  along below that is outside the table. The handling is a decision to make and document (for example blend the residuary
  term toward zero as Fn goes to 0). Mark it TUNING GUESS.
- Validity ranges checked (milestone 2) against `bare_hull_resistance.pdf` PDF page 5, Table 1 (models used in the
  regression). Every Laser ratio from Day Table 2 (160 kg) lies inside the fitted range: LCB/Lwl 0.532 (0.500-0.582),
  Cp 0.552 (0.519-0.599), ∇^(2/3)/Aw 0.103 (0.079-0.265), Bwl/Lwl 0.291 (0.170-0.366), LCB/LCF 0.941 (0.920-1.002),
  Bwl/Tc 11.755 (2.46-19.38), Cm 0.757 (0.646-0.790), ∇^(1/3)/Lwl 0.143 (0.12-0.23).
- Implementation check: friction (ITTC-1957, Rn on 0.7 Lwl) + this residuary term reproduces Day's own "Delft level
  Trim 80kg" curve in Fig. 2 (PDF p7) within 0-2.5 % over 2-8.5 kn, and is up to 9 % below the tank data at 3.5-4.5 kn,
  consistent with Day's remark that Delft under-predicts by as much as 8 % at 3-5 kn.

## Lateral force of hull + board (keel) [image]

```
L_k = (dC_L,k / dα) · c_hull · c_keel · α_eff,k · ½ · ρ · V_eff,k² · A_lat,k
```

## Lift slope [image]

```
dC_L,k / dα = 5.7 · AR_E / ( 1.8 + cos Λ · sqrt( (AR_E² / cos⁴Λ)² + 4 ) )
```

- The printed form has an outer square (confirmed on the 300 dpi page image, inside the root, applied to
  AR_E²/cos⁴Λ). Treated as a misprint (decision, milestone 2).
- Hand check at AR_E = 4, Λ = 0: without the outer square the slope is about 3.6 per rad. With it, about 1.3 per rad.
  Lifting-line theory for an elliptic wing of aspect ratio 4 gives about 4.2 per rad, so 3.6 is plausible and 1.3 is not.
  Implemented as `models.liftSlope`: `'standard'` (no outer square, default) or `'printed'`.

## Lateral force of rudder [image]

```
L_r = (dC_L,r / dα) · c_hull · c_keel · α_eff,r · ½ · ρ · V_eff,r² · A_lat,r
```

## Supporting definitions [typed]

```
AR_E       = 2 · b_k / c_k              (effective aspect ratio of the daggerboard)
c_hull     = 1 + 1.80 · (T_c / b_k)
c_heel     = 1 − 0.382 · φ              (φ in radians; this IS c_keel, see below)
α_eff,r    = λ − λ0 − δ_r − Φ
Φ          = a0 · sqrt( C_L,k / AR_eff,k )
λ0         = ( 0.405 · (B_wl / T_c) · φ )²
```

Resolved (milestone 2, from page images):
- **c_keel = c_heel.** Day's nomenclature (PDF p2) defines c_keel as "Heel influence coefficient". The p6 text gives
  "the heel influence coefficient ... c_heel = 1 − 0.382φ where the heel angle φ is expressed in radians". c_heel
  appears in no equation; c_keel appears in Eqs. 11 and 12. Same quantity printed under two symbols.
- **B_wl** is waterline beam, **T_c** canoe body draught (nomenclature, PDF p2). The page prints B_wl, not B_w.

Open points:
- **AR_eff,k** is not named on the page. It may be AR_E modified by the hull effect, but that is a guess. Write down the
  interpretation you pick and mark it TUNING GUESS.
  Picked: AR_eff,k = AR_E · e (Eq. 17), TUNING GUESS.
- **Downwash a0:** Day does not give a numeric value (per the milestone 1 report). Still a TUNING GUESS unless the page says otherwise.

## λ0 units (the suspect formula)

Page findings (milestone 2): the nomenclature (PDF p2) lists λ0 "Zero-lift drift angle" and φ "Heel angle" with no units
(the nomenclature gives no units at all). The only unit statement near the formula is "φ in radians", attached to c_heel.
The printed formula is a square and carries no sign.

With B_w/T_c = 11.755 and φ in radians, `(0.405 · 11.755 · φ)²` evaluates to:

| Heel | Value | If radians | If degrees |
|---|---|---|---|
| 5° | 0.173 | 9.9° | 0.17° |
| 10° | 0.690 | 39.6° | 0.69° |
| 20° | 2.76 | 158° | 2.8° |
| 30° | 6.21 | 356° | 6.2° |

Read as radians the result is absurd, which matches the collapsed polar. **Hypothesis (not confirmed):** the formula
is a regression whose output is in degrees, with φ in radians. A zero-lift drift of a few degrees at 20-30° heel is the
right order of magnitude. Check the nomenclature on the page for the unit of λ0 and of φ before changing code.
(The milestone 1 report said 13° at 5° heel. The arithmetic here gives 9.9° for a radians reading, so have the agent print
the exact inputs it used for B_w/T_c.)
Checked: the code used B_wl/T_c = 11.755 and φ in radians; the result is 9.9° at 5° heel. The 13° in the milestone 1
report was an arithmetic error in the report, not in the code.
Implemented as `models.lambda0Unit` (`'deg'` default, `'rad'`) and `models.lambda0Sign` (+1: applied with sign(φ),
ASSUMPTION; −1: opposite).

## Induced resistance, Eqs. 15-17 (PDF p7) [image]

```
R_i  = F_h² / ( π · ½ · ρ · V_b² · T_E² )
T_E / T = ( A1 · T_c/T + A2 · (T_c/T)² + A3 · B_wl/T_c + A4 · TR ) · ( B0 + B1 · F_n )          (15)

C_Di = C_L² / ( π · AR_E )                                                                      (16)

e    = 1 / ( 1 + f(TR − ΔTR) · AR )                                                             (17)
ΔTR  = −0.357 + 0.45 · exp(0.0375 · Λ)
f(TR) = 0.0524 TR⁴ − 0.1500 TR³ + 0.1659 TR² − 0.0706 TR + 0.0119
```

- Eq. 15 coefficients are "tabulated for different heel angles". **Known gap:** that table is in neither Day nor
  `bare_hull_resistance.pdf`. The sim uses Eq. 16 for the board as well as the rudder.
- Eq. 16/17 text: "The planform efficiency e for a tapered swept foil where AR_E = AR. e" — read as AR_E = AR · e.
  AR includes the free-surface image; heel multiplies it by cos²φ. The unit of Λ in ΔTR is not stated (degrees assumed).

## Still needed from the page image

- Nothing further is printed on the page for λ0 units, a0, or AR_eff,k. Eq. 15 coefficients need the Keuning & Katgert
  (2008) source.
