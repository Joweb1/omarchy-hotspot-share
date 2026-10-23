import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons

// Native Hotspot Share panel. Appears only while a usable hotspot/LAN address
// exists. This widget owns the server process: it starts sharing when a LAN
// appears and stops it shortly after the LAN goes away. The phone still uses
// the browser app — this is the laptop-side app.
Panel {
  id: root
  moduleName: "jovibe.hotspot-share"
  ipcTarget: "jovibe.hotspot-share"

  readonly property string hs: decodeURIComponent(Qt.resolvedUrl("hs").toString().replace(/^file:\/\//, ""))
  readonly property string netStatus: decodeURIComponent(Qt.resolvedUrl("net-status").toString().replace(/^file:\/\//, ""))

  property bool lanUp: false
  property string ifname: ""
  property string address: ""
  property bool paused: false
  property bool serviceUp: false
  property double lanDownSince: 0
  property var state: ({ network: {}, devices: [], offers: [], send: [], received: [] })

  property string qrMode: "ip"
  property string qrUrl: ""
  property var qrRows: []
  property int qrSize: 0
  property bool qrFailed: false

  readonly property string urlName: (state && state.network) ? String(state.network.urlName || "") : ""
  readonly property string urlIp: (state && state.network) ? String(state.network.urlIp || "") : ""
  readonly property string urlSetup: (state && state.network) ? String(state.network.setupUrl || "") : ""
  readonly property string wantedUrl: serviceUp
    ? (qrMode === "setup" ? urlSetup : qrMode === "name" ? urlName : urlIp)
    : ""
  readonly property var devices: (state && state.devices) ? state.devices : []
  readonly property var sendFiles: (state && state.send) ? state.send : []
  readonly property var receivedFiles: (state && state.received) ? state.received : []
  readonly property var offers: (state && state.offers)
    ? state.offers.filter(function(o) { return o.status === "pending" || o.status === "accepted" })
    : []

  visible: root.setting("alwaysShow", false) || root.lanUp
  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  function glyph(cp) { return String.fromCodePoint(cp) }

  function bytes(n) {
    n = Number(n) || 0
    if (n < 1024) return n + " B"
    var u = ["KB", "MB", "GB", "TB"]
    var i = -1
    do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + " " + u[i]
  }

  function ago(t) {
    var s = Math.max(0, (Date.now() - (Number(t) || 0)) / 1000)
    if (s < 60) return "now"
    if (s < 3600) return Math.floor(s / 60) + "m"
    if (s < 86400) return Math.floor(s / 3600) + "h"
    return Math.floor(s / 86400) + "d"
  }

  function statusLine() {
    if (!lanUp) return "NO NETWORK"
    if (paused) return "PAUSED · " + ifname
    if (!serviceUp) return "STARTING · " + ifname
    if (devices.length > 0) return (devices.length === 1 ? "1 DEVICE CONNECTED" : devices.length + " DEVICES CONNECTED")
    return "READY · " + ifname
  }

  function offerProgress(o) {
    var total = 0, got = 0
    o.files.forEach(function(f) {
      total += Number(f.size) || 0
      got += f.status === "done" ? (Number(f.size) || 0) : (Number(f.got) || 0)
    })
    return total ? Math.min(100, Math.round((got / total) * 100)) : 0
  }

  function applyNet(raw) {
    var line = String(raw || "").trim()
    if (line === "") {
      lanUp = false; ifname = ""; address = ""; paused = false
      if (serviceUp && lanDownSince === 0) lanDownSince = Date.now()
      return
    }
    var f = line.split("\t")
    lanUp = true
    lanDownSince = 0
    ifname = f[0] || ""
    address = f[1] || ""
    paused = f[2] === "1"
    if (!paused && !serviceUp) act("start")
  }

  function applyState(raw) {
    var s = null
    try { s = JSON.parse(String(raw || "")) } catch (e) { return }
    if (!s || typeof s !== "object") return
    state = s
    serviceUp = true
    if (s.network && s.network.up) {
      if (s.network.ip) address = s.network.ip
      if (s.network.ifname) ifname = s.network.ifname
    }
  }

  function applyQr(raw) {
    var lines = String(raw || "").replace(/\r/g, "").split("\n")
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    if (lines.length === 0) { qrRows = []; qrSize = 0; return }
    var chars = lines[0].length
    if (chars % 2 !== 0) { qrFailed = true; return }
    var size = chars / 2
    if (lines.length !== size) { qrFailed = true; return }
    var rows = []
    for (var r = 0; r < size; r++) {
      if (lines[r].length !== chars) { qrFailed = true; return }
      var row = ""
      for (var c = 0; c < chars; c += 2) row += lines[r].substr(c, 2).indexOf("#") >= 0 ? "1" : "0"
      rows.push(row)
    }
    qrRows = rows
    qrSize = size
    qrFailed = false
  }

  function act(verb, arg) {
    if (actionProc.running) return
    actionProc.command = (arg === undefined || arg === null)
      ? [hs, verb]
      : [hs, verb, String(arg)]
    actionProc.running = true
  }

  function refresh() {
    netProc.running = true
    stateProc.running = true
  }

  onWantedUrlChanged: qrUrl = wantedUrl
  onQrUrlChanged: {
    qrRows = []
    qrSize = 0
    qrFailed = false
    if (qrUrl === "") return
    qrProc.running = false
    qrProc.running = true
  }
  onOpenedChanged: if (opened) refresh()

  Process {
    id: netProc
    command: [root.netStatus]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyNet(text)
    }
  }

  Process {
    id: stateProc
    command: [root.hs, "state"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyState(text)
    }
    onExited: function(exitCode) {
      if (exitCode !== 0) {
        root.serviceUp = false
        root.state = ({ network: {}, devices: [], offers: [], send: [], received: [] })
      }
    }
  }

  Process {
    id: qrProc
    command: root.qrUrl !== ""
      ? ["qrencode", "-t", "ASCII", "-m", "4", "-o", "-", root.qrUrl]
      : []
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyQr(text)
    }
    onExited: function(exitCode) { if (exitCode !== 0) root.qrFailed = true }
  }

  Process {
    id: actionProc
    command: []
    onExited: function() { root.refresh() }
  }

  Timer {
    interval: 2000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: netProc.running = true
  }

  Timer {
    interval: 3000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: if (!stateProc.running) stateProc.running = true
  }

  Timer {
    interval: 3000
    running: root.serviceUp && !root.lanUp
    repeat: true
    onTriggered: {
      if (root.lanDownSince > 0 && Date.now() - root.lanDownSince >= 15000) root.act("halt")
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.glyph(0xF011C)
    tooltipText: !root.lanUp
      ? "Hotspot Share"
      : root.paused
        ? "Hotspot Share · paused"
        : "Hotspot Share · " + (root.address || root.ifname || "connected")
    onPressed: root.toggle()
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()

      Column {
        id: column
        anchors.fill: parent
        spacing: Style.space(12)

        Item {
          width: parent.width
          implicitHeight: Math.max(heroIcon.implicitHeight, heroLabels.implicitHeight)

          Text {
            id: heroIcon
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: root.glyph(0xF011C)
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.display
          }

          Column {
            id: heroLabels
            anchors.left: heroIcon.right
            anchors.leftMargin: Style.space(14)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Hotspot Share"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }

            Text {
              textFormat: Text.PlainText
              text: root.statusLine()
              color: Qt.darker(root.bar.foreground, 1.4)
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }
        }

        PanelSeparator { foreground: root.bar.foreground }

        Text {
          visible: !root.lanUp
          width: parent.width
          textFormat: Text.PlainText
          text: "Connect this laptop to your phone's hotspot. The icon appears automatically, and sharing starts and stops with the network."
          color: Qt.darker(root.bar.foreground, 1.5)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
        }

        Column {
          visible: root.lanUp
          width: parent.width
          spacing: Style.space(10)

          Rectangle {
            width: parent.width
            height: Style.space(34)
            radius: Style.space(8)
            color: Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.08)
            visible: root.serviceUp && root.qrUrl !== ""

            Text {
              anchors.left: parent.left
              anchors.leftMargin: Style.space(10)
              anchors.right: copyText.left
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              text: root.qrUrl
              elide: Text.ElideMiddle
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            Text {
              id: copyText
              anchors.right: parent.right
              anchors.rightMargin: Style.space(10)
              anchors.verticalCenter: parent.verticalCenter
              text: "copy"
              color: root.bar.foreground
              font.family: root.bar.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.act("copy", root.qrUrl)
              }
            }
          }

          Rectangle {
            id: qrBox
            readonly property int moduleSize: root.qrSize > 0
              ? Math.max(3, Math.floor(Style.space(210) / root.qrSize))
              : 0

            visible: root.serviceUp && root.qrSize > 0 && !root.qrFailed
            anchors.horizontalCenter: parent.horizontalCenter
            width: root.qrSize * moduleSize
            height: width
            color: "white"
            radius: Style.space(8)

            Grid {
              anchors.fill: parent
              columns: root.qrSize

              Repeater {
                model: root.qrSize * root.qrSize

                Rectangle {
                  required property int index
                  readonly property int row: Math.floor(index / root.qrSize)
                  readonly property int col: index % root.qrSize

                  width: qrBox.moduleSize
                  height: qrBox.moduleSize
                  color: root.qrRows[row] && root.qrRows[row].charAt(col) === "1" ? "#111111" : "transparent"
                }
              }
            }
          }

          Text {
            visible: root.serviceUp && root.qrFailed
            width: parent.width
            text: "Could not render the QR code. Use the link above."
            color: root.bar.foreground
            opacity: 0.7
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Row {
            spacing: Style.space(8)

            PillButton {
              label: "ip"
              primary: root.qrMode === "ip"
              onClicked: root.qrMode = "ip"
            }
            PillButton {
              label: "setup"
              primary: root.qrMode === "setup"
              onClicked: root.qrMode = "setup"
            }
            PillButton {
              label: "name"
              primary: root.qrMode === "name"
              onClicked: root.qrMode = "name"
            }
          }

          Row {
            spacing: Style.space(8)

            PillButton {
              label: root.paused || !root.serviceUp ? "start sharing" : "stop sharing"
              primary: root.paused || !root.serviceUp
              onClicked: root.paused || !root.serviceUp ? root.act("start") : root.act("stop")
            }
            PillButton {
              label: "send folder"
              onClicked: root.act("open-send")
            }
            PillButton {
              label: "fix firewall"
              onClicked: root.act("firewall")
            }
          }

          Text {
            visible: root.serviceUp
            width: parent.width
            textFormat: Text.PlainText
            text: "Phone can't connect? Run \"fix firewall\" once after connecting to a new hotspot."
            color: Qt.darker(root.bar.foreground, 1.4)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Text {
            visible: root.qrMode === "setup"
            width: parent.width
            textFormat: Text.PlainText
            text: "First time? Scan setup, install the certificate on the phone, then switch to ip."
            color: Qt.darker(root.bar.foreground, 1.4)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          Text {
            visible: root.devices.length > 0
            width: parent.width
            textFormat: Text.PlainText
            text: "devices · " + root.devices.map(function(d) { return d.label }).join(", ")
            color: Qt.darker(root.bar.foreground, 1.4)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }

        PanelSeparator { visible: root.offers.length > 0; foreground: root.bar.foreground }

        Column {
          visible: root.offers.length > 0
          width: parent.width
          spacing: Style.space(8)

          PanelSectionHeader {
            text: "INCOMING"
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
          }

          Repeater {
            model: root.offers

            delegate: Rectangle {
              required property var modelData
              width: column.width
              height: offerColumn.implicitHeight + Style.space(20)
              radius: Style.space(8)
              color: Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.06)

              Column {
                id: offerColumn
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: Style.space(10)
                spacing: Style.space(8)

                Text {
                  width: parent.width
                  textFormat: Text.PlainText
                  text: (modelData.label || "device") + " · "
                    + (modelData.files.length === 1 ? modelData.files[0].name : modelData.files.length + " files")
                  color: root.bar.foreground
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  elide: Text.ElideMiddle
                }

                Row {
                  visible: modelData.status === "pending"
                  spacing: Style.space(8)

                  PillButton {
                    label: "accept"
                    primary: true
                    onClicked: root.act("accept", modelData.id)
                  }
                  PillButton {
                    label: "decline"
                    onClicked: root.act("decline", modelData.id)
                  }
                }

                Text {
                  visible: modelData.status === "accepted"
                  text: root.offerProgress(modelData) + "%"
                  color: Qt.darker(root.bar.foreground, 1.4)
                  font.family: root.bar.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }
          }
        }

        PanelSeparator { visible: root.sendFiles.length + root.receivedFiles.length > 0; foreground: root.bar.foreground }

        Column {
          visible: root.sendFiles.length + root.receivedFiles.length > 0
          width: parent.width
          spacing: Style.space(6)

          PanelSectionHeader {
            visible: root.sendFiles.length > 0
            text: "SEND FOLDER"
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
          }

          Repeater {
            model: root.sendFiles
            delegate: FileRow {
              required property var modelData
              width: column.width
              entry: modelData
              deleteVerb: "delete-send"
            }
          }

          PanelSectionHeader {
            visible: root.receivedFiles.length > 0
            text: "RECEIVED"
            foreground: root.bar.foreground
            fontFamily: root.bar.fontFamily
          }

          Repeater {
            model: root.receivedFiles
            delegate: FileRow {
              required property var modelData
              width: column.width
              entry: modelData
              deleteVerb: "delete-recv"
            }
          }

          PillButton {
            label: "open received folder"
            onClicked: root.act("open-received")
          }
        }
      }
    }
  }

  component PillButton: Rectangle {
    id: pb
    property string label: ""
    property bool primary: false
    signal clicked()

    implicitWidth: labelText.implicitWidth + Style.space(24)
    implicitHeight: Style.space(28)
    radius: Style.space(7)
    color: primary
      ? root.bar.foreground
      : Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.10)
    border.width: primary ? 0 : 1
    border.color: Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.25)

    Text {
      id: labelText
      anchors.centerIn: parent
      text: pb.label
      color: pb.primary ? root.bar.background : root.bar.foreground
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    MouseArea {
      anchors.fill: parent
      cursorShape: Qt.PointingHandCursor
      onClicked: pb.clicked()
    }
  }

  component FileRow: Rectangle {
    id: fr
    required property var entry
    property string deleteVerb: ""

    height: Style.space(30)
    color: "transparent"

    Text {
      id: nameText
      anchors.left: parent.left
      anchors.right: sizeText.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      text: fr.entry.name
      elide: Text.ElideMiddle
      color: root.bar.foreground
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Text {
      id: sizeText
      anchors.right: deleteText.left
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      text: root.bytes(fr.entry.size) + " · " + root.ago(fr.entry.mtime)
      color: Qt.rgba(root.bar.foreground.r, root.bar.foreground.g, root.bar.foreground.b, 0.55)
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.caption
    }

    Text {
      id: deleteText
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      text: "×"
      color: root.bar.foreground
      font.family: root.bar.fontFamily
      font.pixelSize: Style.font.heading

      MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: if (fr.deleteVerb !== "") root.act(fr.deleteVerb, fr.entry.name)
      }
    }
  }
}
