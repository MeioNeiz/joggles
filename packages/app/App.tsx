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
import { Connected } from './src/screens/Connected.js'
import { Scan } from './src/screens/Scan.js'

export default function App() {
  const [glasses, setGlasses] = useState<Glasses | null>(null)

  async function close() {
    const open = glasses
    setGlasses(null)
    // 'keep' leaves whatever is on the panel alone. Leaving DIY would make the firmware
    // restore the vendor's saved image, which looks like stray pixels from nowhere.
    await open?.end('keep').catch(() => {})
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      {glasses ? (
        <Connected glasses={glasses} onClose={close} />
      ) : (
        <Scan onOpen={setGlasses} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#111', padding: 24, paddingTop: 96 },
})
