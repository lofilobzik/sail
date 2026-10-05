// Package data embeds the JSON configuration shared by the browser (TypeScript, imported by Vite)
// and the Go server. The JSON files are the single source of truth for both.
package data

import "embed"

// FS holds every *.json file in this directory.
//
//go:embed *.json
var FS embed.FS
