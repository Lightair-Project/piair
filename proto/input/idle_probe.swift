import CoreGraphics
import Foundation
func idle(_ s: CGEventSourceStateID) -> Double { CGEventSource.secondsSinceLastEventType(s, eventType: CGEventType(rawValue: ~0)!) }
let start = CGEvent(source: nil)!.location
for (name, sid) in [("private", CGEventSourceStateID.privateState), ("hid", .hidSystemState), ("combined", .combinedSessionState)] {
  let src = CGEventSource(stateID: sid)
  Thread.sleep(forTimeInterval: 0.6)
  var line = "\(name): before hid=\(String(format: "%.2f", idle(.hidSystemState)))"
  for i in 0..<60 {
    let p = CGPoint(x: start.x + Double(i % 20) * 2, y: start.y)
    let e = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)!
    e.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.016)
    if i % 20 == 19 { line += " t\(i)=hid \(String(format: "%.2f", idle(.hidSystemState))) comb \(String(format: "%.2f", idle(.combinedSessionState)))" }
  }
  print(line)
}
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: start, mouseButton: .left)!.post(tap: .cghidEventTap)
