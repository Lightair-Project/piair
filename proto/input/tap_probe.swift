import CoreGraphics
import Foundation
var tagged = 0, untagged = 0, pids = Set<Int64>()
let mask: CGEventMask = (1 << CGEventType.mouseMoved.rawValue) | (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.keyDown.rawValue)
let tap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, e, _ in
  if e.getIntegerValueField(.eventSourceUserData) == 0x50694169 { tagged += 1 } else { untagged += 1; pids.insert(e.getIntegerValueField(.eventSourceUnixProcessID)) }
  return Unmanaged.passUnretained(e)
}, userInfo: nil)
print("tap:", tap != nil)
let rl = CFMachPortCreateRunLoopSource(nil, tap!, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), rl, .commonModes)
CGEvent.tapEnable(tap: tap!, enable: true)
let start = CGEvent(source: nil)!.location
let src = CGEventSource(stateID: .privateState)
for i in 0..<20 {
  let e = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: start.x + Double(i), y: start.y), mouseButton: .left)!
  e.setIntegerValueField(.eventSourceUserData, value: 0x50694169)
  e.post(tap: .cghidEventTap)
  CFRunLoopRunInMode(.defaultMode, 0.016, false)
}
let u = CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: start, mouseButton: .left)!
u.post(tap: .cghidEventTap)
CFRunLoopRunInMode(.defaultMode, 0.2, false)
print("tagged", tagged, "untagged", untagged, "untagged pids", pids)
