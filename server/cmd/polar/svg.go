package main

import (
	"fmt"
	"math"
	"strings"
)

// Port of scripts/lib/svgPolar.ts: minimal SVG polar plot, boat speed (radius) vs true wind angle,
// one curve per wind speed.

type polarPoint struct{ twaDeg, speedKn float64 }

type polarCurve struct {
	label  string
	points []polarPoint
}

var colors = []string{"#1f77b4", "#d62728", "#2ca02c", "#9467bd", "#ff7f0e"}

func polarSvg(curves []polarCurve, title string) string {
	const size = 520.0
	const cx = 60.0
	const cy = size / 2
	const radius = size/2 - 40
	maxSpeed := 1.0
	for _, c := range curves {
		for _, p := range c.points {
			maxSpeed = max(maxSpeed, p.speedKn)
		}
	}
	ringStep := 0.5
	if maxSpeed > 4 {
		ringStep = 1
	}
	rMax := math.Ceil(maxSpeed/ringStep) * ringStep
	toXY := func(twaDeg, speed float64) (float64, float64) {
		a := (twaDeg * math.Pi) / 180
		r := (speed / rMax) * radius
		return cx + r*math.Sin(a), cy - r*math.Cos(a)
	}
	n := jsString
	var parts []string
	add := func(format string, args ...any) { parts = append(parts, fmt.Sprintf(format, args...)) }
	add(`<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" font-family="sans-serif" font-size="11">`, n(size), n(size))
	add(`<rect width="100%%" height="100%%" fill="white"/>`)
	add(`<text x="10" y="16" font-size="13">%s</text>`, title)
	for s := ringStep; s <= rMax+1e-9; s += ringStep {
		r := (s / rMax) * radius
		add(`<path d="M %s %s A %s %s 0 0 1 %s %s" fill="none" stroke="#ddd"/>`, n(cx), n(cy-r), n(r), n(r), n(cx), n(cy+r))
		add(`<text x="%s" y="%s" fill="#888">%s kn</text>`, n(cx+3), n(cy-r+12), n(s))
	}
	for a := 0.0; a <= 180; a += 30 {
		x, y := toXY(a, rMax)
		add(`<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="#eee"/>`, n(cx), n(cy), n(x), n(y))
		tx, ty := toXY(a, rMax*1.06)
		add(`<text x="%s" y="%s" fill="#888">%s</text>`, n(tx-8), n(ty+4), n(a))
	}
	for i, c := range curves {
		color := colors[i%len(colors)]
		d := make([]string, len(c.points))
		for j, p := range c.points {
			cmd := "L"
			if j == 0 {
				cmd = "M"
			}
			x, y := toXY(p.twaDeg, p.speedKn)
			d[j] = fmt.Sprintf("%s %s %s", cmd, n(x), n(y))
		}
		add(`<path d="%s" fill="none" stroke="%s" stroke-width="2"/>`, strings.Join(d, " "), color)
		for _, p := range c.points {
			x, y := toXY(p.twaDeg, p.speedKn)
			add(`<circle cx="%s" cy="%s" r="2.5" fill="%s"/>`, n(x), n(y), color)
		}
		add(`<text x="%s" y="%s" fill="%s">%s</text>`, n(size-110), n(30+float64(i)*16), color, c.label)
	}
	parts = append(parts, "</svg>")
	return strings.Join(parts, "\n")
}
