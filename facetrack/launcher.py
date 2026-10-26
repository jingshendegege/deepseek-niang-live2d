"""Local-only static server rooted at the model's parent directory."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import functools, sys, threading, urllib.request, webbrowser

ROOT = Path(__file__).resolve().parent.parent
URL = 'http://localhost:8765/facetrack/index.html'

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.wasm': 'application/wasm'}
    def end_headers(self):
        # The export is updated by a separate task; always read the current files.
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

if __name__ == '__main__':
    try:
        server = ThreadingHTTPServer(('127.0.0.1', 8765), functools.partial(Handler, directory=str(ROOT)))
    except OSError:
        try:
            with urllib.request.urlopen(URL, timeout=3) as response:
                same_page = 'DeepSeek娘'.encode() in response.read()
            if not same_page:
                raise RuntimeError('Port occupied by a different server')
        except Exception:
            print('端口 8765 被其他程序占用。请关闭占用程序后重新启动。')
            sys.exit(1)
        if '--no-open' not in sys.argv:
            webbrowser.open(URL)
        print('已使用正在运行的面捕测试台：' + URL)
        sys.exit(0)
    print('面捕测试台：' + URL, flush=True)
    print('服务器根目录：' + str(ROOT), flush=True)
    print('关闭此窗口或按 Ctrl+C 停止服务。', flush=True)
    if '--no-open' not in sys.argv:
        timer = threading.Timer(.5, lambda: webbrowser.open(URL))
        timer.daemon = True
        timer.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
