"""Serve MoodLens on http://localhost:8000 without browser caching,
so edits to the site show up on a normal refresh."""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    print(f"MoodLens running at http://localhost:{PORT}  (Ctrl+C to stop)")
    http.server.ThreadingHTTPServer(("", PORT), NoCacheHandler).serve_forever()
