package main

import (
	"net/http"
	"strings"
)

// staticSite serves the Vite build (dist/). Vite fingerprints everything under /assets/, so those
// files never change and may be cached forever; everything else (index.html) is revalidated on each
// load so a new deploy is picked up at once.
func staticSite(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
