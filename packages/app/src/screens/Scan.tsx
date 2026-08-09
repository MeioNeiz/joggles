/**
 * Find a pair and open a connection.
 *
 * Deliberately a list rather than "connect to the first thing seen": at a festival there
 * are several pairs in range and the CLI's one-shot behaviour is the wrong model for a
 * phone. RSSI is shown because it is the only cue about which pair is the one in your
 * hand.
 *
 * Nothing here writes to the device. Connecting is a read-only act.
 *
 * **The scan stops itself.** A continuous BLE scan is among the most expensive things
 * an app can leave running - the controller wakes the CPU for every advert from every
 * device in range, and at a festival that is hundreds - so leaving this screen open
 * used to drain the battery indefinitely for nothing. It now runs for `SCAN_MS` and
 * then waits to be asked again.
 */
import { Glasses, type Discovered } from '@joggles/core'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { scanner } from '../ble.js'
import { flashBudget } from '../ledger.js'

/** Long enough to find a pair that is switched on, short enough not to cost anything. */
const SCAN_MS = 20_000

export function Scan({ onOpen }: { onOpen: (glasses: Glasses) => void }) {
  const [units, setUnits] = useState<Discovered[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [scanning, setScanning] = useState(true)
  /** Bumped by "Scan again", which is the only thing that restarts the effect. */
  const [round, setRound] = useState(0)

  useEffect(() => {
    let live = true
    setScanning(true)
    scanner
      .scan((unit) => {
        if (!live) return
        // Replace on re-sighting so RSSI stays current rather than appending duplicates.
        setUnits((prev) => [...prev.filter((u) => u.id !== unit.id), unit])
      })
      .catch((e) => live && setError(String(e.message ?? e)))

    const done = setTimeout(() => {
      if (!live) return
      setScanning(false)
      scanner.stop().catch(() => {})
    }, SCAN_MS)

    return () => {
      live = false
      clearTimeout(done)
      scanner.stop().catch(() => {})
    }
  }, [round])

  async function connect(unit: Discovered) {
    setBusy(unit.id)
    setError(null)
    try {
      const transport = await scanner.connect(unit.id)
      // The app's one budget, not a fresh one per connection: reconnecting must not
      // hand anyone a new allowance, and the ledger is keyed by the advert name,
      // which carries the last three bytes of the MAC. The platform's own id does
      // not identify a unit across phones.
      onOpen(await Glasses.attach(transport, unit.name, { budget: flashBudget }))
    } catch (e) {
      setError(String((e as Error).message ?? e))
      setBusy(null)
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>Glasses nearby</Text>

      {units.length === 0 && scanning && !error ? (
        <View style={styles.empty}>
          <ActivityIndicator color="#4ade80" />
          <Text style={styles.hint}>
            Scanning. A pair held by the vendor app will not appear: one connection per
            device.
          </Text>
        </View>
      ) : null}

      {units.map((unit) => (
        <Pressable
          key={unit.id}
          style={styles.unit}
          onPress={() => connect(unit)}
          disabled={busy !== null}
        >
          <Text style={styles.name}>{unit.name}</Text>
          <Text style={styles.rssi}>
            {busy === unit.id ? 'connecting...' : `${unit.rssi} dBm`}
          </Text>
        </Pressable>
      ))}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!scanning ? (
        <Pressable style={styles.again} onPress={() => setRound((n) => n + 1)}>
          <Text style={styles.againText}>
            {units.length === 0 ? 'Nothing found. Scan again' : 'Scan again'}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  heading: { color: '#888', fontSize: 13, letterSpacing: 2 },
  empty: { gap: 12, alignItems: 'flex-start', paddingVertical: 24 },
  hint: { color: '#666', fontSize: 13, lineHeight: 19 },
  unit: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  name: { color: '#eee', fontSize: 17 },
  rssi: { color: '#888', fontSize: 13 },
  error: { color: '#f87171', fontSize: 13, marginTop: 12 },
  again: {
    marginTop: 16,
    paddingVertical: 13,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#333',
    alignItems: 'center',
  },
  againText: { color: '#4ade80', fontSize: 15 },
})
