/**
 * Two screens and the connection between them.
 *
 * The whole app is a state machine over one BLE connection, because the hardware is: one
 * connection per device, and a pair held by the vendor app is simply unavailable. Keeping
 * that at the top means no screen has to wonder whether it has a device.
 */
import type { Glasses } from '@joggles/core'
import { StatusBar } from 'expo-status-bar'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Draw } from './src/draw/Draw.js'
import { Connected } from './src/screens/Connected.js'
import { Scan } from './src/screens/Scan.js'

export default function App() {
  const [glasses, setGlasses] = useState<Glasses | null>(null)
  const [drawing, setDrawing] = useState(false)

  async function close() {
    const open = glasses
    setGlasses(null)
    setDrawing(false)
    // 'keep' leaves whatever is on the panel alone. Leaving DIY would make the firmware
    // restore the vendor's saved image, which looks like stray pixels from nowhere.
    await open?.end('keep').catch(() => {})
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {/* Drawing is a mode of a connected unit, not a third peer of Scan and
          Connected: it needs an open session, and leaving it must not disconnect.
          The two screens keep separate ideas of the panel, so only one is mounted
          at a time - `Draw` drives `LiveSender` and `Connected` sends `MODE`, and
          `MODE` discards the live buffer the drawing lives in. */}
      {glasses ? (
        drawing ? (
          <Draw glasses={glasses} onBack={() => setDrawing(false)} />
        ) : (
          <Connected glasses={glasses} onClose={close} onDraw={() => setDrawing(true)} />
        )
      ) : (
        <Scan onOpen={setGlasses} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#111', padding: 24, paddingTop: 96 },
})
