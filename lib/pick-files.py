#!/usr/bin/env python3
"""Open the desktop file chooser (xdg-desktop-portal) and print the chosen file paths, one per line."""
import sys
from urllib.parse import unquote, urlparse

import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION)
loop = GLib.MainLoop()
status = [1]

sender = bus.get_unique_name()[1:].replace('.', '_')
token = 'hotspot_share_pick'
handle = f'/org/freedesktop/portal/desktop/request/{sender}/{token}'


def on_response(_conn, _sender, _path, _iface, _signal, params, _data):
    code, results = params.unpack()
    if code == 0:
        for uri in results.get('uris', []):
            u = urlparse(uri)
            if u.scheme == 'file':
                print(unquote(u.path))
        status[0] = 0
    loop.quit()


# Subscribe before the call so the Response cannot be missed.
bus.signal_subscribe('org.freedesktop.portal.Desktop', 'org.freedesktop.portal.Request', 'Response',
                     handle, None, Gio.DBusSignalFlags.NONE, on_response, None)

options = {
    'handle_token': GLib.Variant('s', token),
    'multiple': GLib.Variant('b', True),
}
try:
    bus.call_sync('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop',
                  'org.freedesktop.portal.FileChooser', 'OpenFile',
                  GLib.Variant('(ssa{sv})', ('', 'Send files', options)),
                  None, Gio.DBusCallFlags.NONE, -1)
except GLib.Error as e:
    print(f'pick-files: {e.message}', file=sys.stderr)
    sys.exit(1)

loop.run()
sys.exit(status[0])
