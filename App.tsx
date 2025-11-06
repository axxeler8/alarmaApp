import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  KeyboardAvoidingView,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker from '@react-native-community/datetimepicker';
import { DeviceEventEmitter, NativeModules } from 'react-native';

type ItemType = 'alarm' | 'timer';

type ActiveItem = {
  id: string;
  type: ItemType;
  label: string;
  // For alarms: absolute timestamp (ms since epoch). For timer: target timestamp.
  triggerAt: number;
  // Last scheduled notification identifier (for cancel/reschedule)
  notificationId?: string;
  createdAt: number;
};

type HistoryItem = {
  id: string;
  type: ItemType;
  label: string;
  createdAt: number;
  firedAt: number;
  snoozes?: number;
};

const STORAGE_ACTIVE = 'appalarma.activeItems.v1';
const STORAGE_HISTORY = 'appalarma.historyItems.v1';

// Configure how notifications are displayed when app is foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export default function App() {
  const [ready, setReady] = useState(false);
  const [activeItems, setActiveItems] = useState<ActiveItem[]>([]);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [tab, setTab] = useState<'crear' | 'activas' | 'historial'>('crear');
  const activeItemsRef = useRef<ActiveItem[]>([]);

  // Create form state
  const [mode, setMode] = useState<ItemType>('alarm');
  const [alarmDate, setAlarmDate] = useState<Date>(new Date(Date.now() + 5 * 60 * 1000));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [timerMinutes, setTimerMinutes] = useState<number>(10);
  // Lazy load Slider to avoid crashing dev client if native module isn't included
  const SliderComp: any = useMemo(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('@react-native-community/slider').default;
    } catch {
      return null;
    }
  }, []);

  // Ringing modal state
  const [ringingItemId, setRingingItemId] = useState<string | null>(null);
  const ringingItem = useMemo(() => activeItems.find(i => i.id === ringingItemId) || null, [activeItems, ringingItemId]);
  const snoozeCountsRef = useRef<Record<string, number>>({});

  const loadData = useCallback(async () => {
    try {
      const [a, h] = await Promise.all([
        AsyncStorage.getItem(STORAGE_ACTIVE),
        AsyncStorage.getItem(STORAGE_HISTORY),
      ]);
      setActiveItems(a ? JSON.parse(a) : []);
      setHistoryItems(h ? JSON.parse(h) : []);
    } catch (e) {
      console.warn('Failed to load storage', e);
    } finally {
      setReady(true);
    }
  }, []);

  const saveActive = useCallback(async (items: ActiveItem[]) => {
    setActiveItems(items);
    await AsyncStorage.setItem(STORAGE_ACTIVE, JSON.stringify(items));
  }, []);
  // Keep a ref with the latest active items, used by native event listeners
  useEffect(() => {
    activeItemsRef.current = activeItems;
  }, [activeItems]);


  const saveHistory = useCallback(async (items: HistoryItem[]) => {
    setHistoryItems(items);
    await AsyncStorage.setItem(STORAGE_HISTORY, JSON.stringify(items));
  }, []);

  // Setup notifications channel and permissions
  useEffect(() => {
    let sub3: { remove: () => void } | undefined;
    let sub1: Notifications.Subscription | undefined;
    let sub2: Notifications.Subscription | undefined;
    (async () => {
      await loadData();
      // Android setup
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('alarm_high_v1', {
          name: 'Alarmas',
          importance: Notifications.AndroidImportance.MAX,
          sound: 'default',
          vibrationPattern: [0, 500, 500, 500, 500, 500],
          lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        });
        // Ask for notification permission on Android 13+
        try {
          const { status } = await Notifications.getPermissionsAsync();
          if (status !== 'granted') {
            await Notifications.requestPermissionsAsync();
          }
        } catch {}
        // Exact alarm special access
        try {
          const ok = await NativeModules?.AndroidAlarm?.checkExactAlarmPermission?.();
          if (!ok) NativeModules?.AndroidAlarm?.requestExactAlarmPermission?.();
        } catch {}
        // Listen to actions from the full-screen activity
        sub3 = DeviceEventEmitter.addListener('alarmActivityAction', async (e: any) => {
          const { id, action, triggerAt } = e || {};
          const item = activeItemsRef.current.find((i) => i.id === id);
          if (!item) return;
          if (action === 'dismiss') {
            await moveToHistory(item);
          } else if (action === 'snooze' && triggerAt) {
            const updated: ActiveItem = { ...item, triggerAt: Number(triggerAt) };
            snoozeCountsRef.current[id] = (snoozeCountsRef.current[id] || 0) + 1;
            await updateItem(updated);
          }
        });
      } else {
        // iOS / web: request permissions and wire listeners
        try {
          const { status } = await Notifications.getPermissionsAsync();
          if (status !== 'granted') {
            await Notifications.requestPermissionsAsync();
          }
        } catch {}

        sub1 = Notifications.addNotificationReceivedListener((n) => {
          const data = n.request.content.data as any;
          if (data && data.id) {
            setRingingItemId(String(data.id));
          }
        });
        sub2 = Notifications.addNotificationResponseReceivedListener((resp) => {
          const data = resp.notification.request.content.data as any;
          if (data && data.id) {
            setRingingItemId(String(data.id));
          }
        });
      }
    })();
    return () => {
      sub3?.remove?.();
      sub1?.remove?.();
      sub2?.remove?.();
    };
  }, [loadData]);

  // Helpers
  const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  const scheduleNotification = async (item: ActiveItem) => {
    if (Platform.OS === 'android' && (NativeModules as any)?.AndroidAlarm) {
      console.log('[schedule] android native', {
        id: item.id,
        type: item.type,
        triggerAt: item.triggerAt,
        now: Date.now(),
        delayMs: Math.max(0, item.triggerAt - Date.now()),
      });
      if (item.type === 'alarm') {
        await (NativeModules as any).AndroidAlarm.scheduleAlarm(item.id, item.triggerAt, item.label || '');
      } else {
        const delay = Math.max(0, item.triggerAt - Date.now());
        await (NativeModules as any).AndroidAlarm.scheduleTimer(item.id, delay, item.label || '');
      }
      return undefined;
    }
    const triggerDate = new Date(item.triggerAt);
    const identifier = await Notifications.scheduleNotificationAsync({
      content: {
        title: item.type === 'alarm' ? '⏰ Alarma' : '⏲️ Temporizador',
        body: item.label || (item.type === 'alarm' ? 'Alarma programada' : 'Temporizador finalizado'),
        sound: 'default',
        data: { id: item.id, type: item.type },
        priority: Notifications.AndroidNotificationPriority.MAX,
      },
      trigger: { date: triggerDate, channelId: 'alarm_high_v1' },
    });
    return identifier;
  };

  // Creation with explicit inputs to avoid parent re-render during typing on some Android devices
  const onCreateWith = async (labelArg: string, timerOverride?: number) => {
    const now = Date.now();
    let triggerAt = now + (typeof timerOverride === 'number' ? timerOverride : timerMinutes) * 60 * 1000;
    if (mode === 'alarm') {
      triggerAt = alarmDate.getTime();
    }
    if (triggerAt <= now) {
      Alert.alert('Fecha/hora inválida', 'Debes seleccionar un momento en el futuro.');
      return;
    }
    const item: ActiveItem = {
      id: genId(),
      type: mode,
      label: labelArg.trim(),
      triggerAt,
      createdAt: now,
    };
    try {
      const nid = await scheduleNotification(item);
      const next = [{ ...item, notificationId: nid }, ...activeItems].sort((a, b) => a.triggerAt - b.triggerAt);
      await saveActive(next);
      // reset form
      if (mode === 'timer') setTimerMinutes(10);
      setTab('activas');
    } catch (e) {
      console.error(e);
      Alert.alert('Error', 'No se pudo programar.');
    }
  };

  const cancelItemNotification = async (item: ActiveItem) => {
    if (Platform.OS === 'android' && (NativeModules as any)?.AndroidAlarm) {
      try { await (NativeModules as any).AndroidAlarm.cancel(item.id); } catch {}
    } else if (item.notificationId) {
      try { await Notifications.cancelScheduledNotificationAsync(item.notificationId); } catch {}
    }
  };

  const deleteItem = async (id: string) => {
    const item = activeItems.find(i => i.id === id);
    if (!item) return;
    await cancelItemNotification(item);
    await saveActive(activeItems.filter(i => i.id !== id));
  };

  const updateItem = async (updated: ActiveItem) => {
    // Cancel previous schedule then reschedule
    await cancelItemNotification(updated);
    const nid = await scheduleNotification(updated);
    const next = activeItems.map(i => (i.id === updated.id ? { ...updated, notificationId: nid } : i)).sort((a,b)=>a.triggerAt-b.triggerAt);
    await saveActive(next);
  };

  const moveToHistory = async (item: ActiveItem) => {
    const firedAt = Date.now();
    const hist: HistoryItem = { id: item.id, type: item.type, label: item.label, createdAt: item.createdAt, firedAt, snoozes: snoozeCountsRef.current[item.id] || 0 };
    await saveHistory([hist, ...historyItems]);
    await saveActive(activeItems.filter(i => i.id !== item.id));
  };

  const onSnooze = async (minutes: number) => {
    if (!ringingItem) return;
    const newTrigger = Date.now() + minutes * 60 * 1000;
    const updated: ActiveItem = { ...ringingItem, triggerAt: newTrigger };
    const count = (snoozeCountsRef.current[ringingItem.id] || 0) + 1;
    snoozeCountsRef.current[ringingItem.id] = count;
    await updateItem(updated);
    setRingingItemId(null);
  };

  const onDismiss = async () => {
    if (!ringingItem) return;
    await cancelItemNotification(ringingItem);
    await moveToHistory(ringingItem);
    setRingingItemId(null);
  };

  // UI Helpers
  const TabButton = ({ id, title }: { id: 'crear' | 'activas' | 'historial'; title: string }) => (
    <Pressable onPress={() => setTab(id)} style={[styles.tabButton, tab === id && styles.tabButtonActive]}>
      <Text style={[styles.tabButtonText, tab === id && styles.tabButtonTextActive]}>{title}</Text>
    </Pressable>
  );

  const ModeSwitch = () => (
    <View style={styles.switchRow}>
      <Pressable onPress={() => setMode('alarm')} style={[styles.modeButton, mode === 'alarm' && styles.modeButtonActive]}>
        <Text style={[styles.modeText, mode === 'alarm' && styles.modeTextActive]}>Alarma</Text>
      </Pressable>
      <Pressable onPress={() => setMode('timer')} style={[styles.modeButton, mode === 'timer' && styles.modeButtonActive]}>
        <Text style={[styles.modeText, mode === 'timer' && styles.modeTextActive]}>Temporizador</Text>
      </Pressable>
    </View>
  );

  const CreateForm = () => {
    const [sliderVal, setSliderVal] = useState<number>(timerMinutes);
    const labelRef = useRef<TextInput>(null);
    const [labelFocused, setLabelFocused] = useState(false);
    const [labelLocal, setLabelLocal] = useState('');
    useEffect(() => {
      if (mode === 'timer') setSliderVal(timerMinutes);
    }, [mode, timerMinutes]);

    return (
    <View style={{ gap: 16 }}>
      <ModeSwitch />
      <View>
        <Text style={styles.label}>Texto (opcional)</Text>
        <TextInput
          ref={labelRef}
          value={labelLocal}
          onChangeText={setLabelLocal}
          placeholder={mode === 'alarm' ? 'p. ej. Tomar medicina' : 'p. ej. Hervir agua'}
          placeholderTextColor="#9fb6d9"
          style={styles.input}
          blurOnSubmit={false}
          returnKeyType="done"
          autoCorrect={false}
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          keyboardType="default"
          disableFullscreenUI
          onFocus={() => setLabelFocused(true)}
          onBlur={() => setLabelFocused(false)}
          onChange={(e) => {
            // En algunos Android, el primer carácter puede provocar un blur
            // Forzamos el focus de nuevo si estaba enfocado
            if (Platform.OS === 'android') {
              requestAnimationFrame(() => {
                if (labelFocused) labelRef.current?.focus();
              });
            }
          }}
        />
      </View>
      {mode === 'alarm' ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.label}>Fecha y hora</Text>
          <View style={styles.row}>
            <Pressable style={styles.pickerButton} onPress={() => setShowDatePicker(true)}>
              <Text style={styles.pickerButtonText}>{alarmDate.toLocaleDateString()}</Text>
            </Pressable>
            <Pressable style={styles.pickerButton} onPress={() => setShowTimePicker(true)}>
              <Text style={styles.pickerButtonText}>{alarmDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
            </Pressable>
          </View>
          {showDatePicker && (
            <DateTimePicker
              value={alarmDate}
              mode="date"
              display="default"
              onChange={(_, d) => {
                setShowDatePicker(false);
                if (d) {
                  const nd = new Date(alarmDate);
                  nd.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
                  setAlarmDate(nd);
                }
              }}
            />
          )}
          {showTimePicker && (
            <DateTimePicker
              value={alarmDate}
              mode="time"
              is24Hour
              display="default"
              onChange={(_, d) => {
                setShowTimePicker(false);
                if (d) {
                  const nd = new Date(alarmDate);
                  nd.setHours(d.getHours(), d.getMinutes(), 0, 0);
                  setAlarmDate(nd);
                }
              }}
            />
          )}
        </View>
      ) : (
        <View>
          <Text style={styles.label}>Minutos: {sliderVal}</Text>
          {SliderComp ? (
            <SliderComp
              value={sliderVal}
              minimumValue={1}
              maximumValue={60}
              step={1}
              minimumTrackTintColor="#2a5ea9"
              maximumTrackTintColor="#1b3a63"
              thumbTintColor="#e6f0ff"
              animateTransitions
              style={styles.slider}
              onValueChange={(v: number) => setSliderVal(Math.max(1, Math.min(60, Math.round(v))))}
              onSlidingComplete={(v: number) => setTimerMinutes(Math.max(1, Math.min(60, Math.round(v))))}
            />
          ) : (
            <View style={[styles.rowBetween, { marginTop: 8 }] }>
              <Pressable style={styles.chip} onPress={() => setSliderVal(v => Math.max(1, v - 1))}>
                <Text style={styles.chipText}>-</Text>
              </Pressable>
              <Text style={styles.itemTitle}>{sliderVal} min</Text>
              <Pressable style={styles.chip} onPress={() => setSliderVal(v => Math.min(60, v + 1))}>
                <Text style={styles.chipText}>+</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
      <Pressable
        style={styles.primaryButton}
        onPress={async () => {
          await onCreateWith(labelLocal, mode === 'timer' ? sliderVal : undefined);
          // limpiar sólo si se creó con éxito (tab cambia a activas)
          setLabelLocal('');
          if (mode === 'timer') setSliderVal(10);
        }}
      >
        <Text style={styles.primaryButtonText}>Programar {mode === 'alarm' ? 'alarma' : 'temporizador'}</Text>
      </Pressable>
    </View>
  ); };

  const ItemRow = ({ item }: { item: ActiveItem }) => (
    <View style={styles.itemRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.itemTitle}>{item.type === 'alarm' ? 'Alarma' : 'Temporizador'} • {new Date(item.triggerAt).toLocaleString()}</Text>
        {!!item.label && <Text style={styles.itemSubtitle}>{item.label}</Text>}
      </View>
      <View style={styles.row}>
        <Pressable style={styles.secondaryButton} onPress={() => startEdit(item)}>
          <Text style={styles.secondaryButtonText}>Editar</Text>
        </Pressable>
        <Pressable style={styles.dangerButton} onPress={() => deleteItem(item.id)}>
          <Text style={styles.dangerButtonText}>Eliminar</Text>
        </Pressable>
      </View>
    </View>
  );

  // Edit modal
  const [editing, setEditing] = useState<ActiveItem | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editDate, setEditDate] = useState<Date>(new Date());
  const [editShowDate, setEditShowDate] = useState(false);
  const [editShowTime, setEditShowTime] = useState(false);
  const startEdit = (item: ActiveItem) => {
    setEditing(item);
    setEditLabel(item.label);
    setEditDate(new Date(item.triggerAt));
  };
  const confirmEdit = async () => {
    if (!editing) return;
    let updated: ActiveItem = { ...editing, label: editLabel };
    if (editing.type === 'alarm') {
      const t = editDate.getTime();
      if (t <= Date.now()) {
        Alert.alert('Fecha inválida', 'Debe ser una hora futura.');
        return;
      }
      updated = { ...updated, triggerAt: t };
    }
    await updateItem(updated);
    setEditing(null);
  };

  return (
    <SafeAreaProvider>
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>App Alarma</Text>
      </View>

      <View style={styles.tabs}>
        <TabButton id="crear" title="Crear" />
        <TabButton id="activas" title="Activas" />
        <TabButton id="historial" title="Historial" />
      </View>

      <View style={styles.content}>
        {tab === 'crear' && (
          <KeyboardAwareScrollView
            enableOnAndroid
            enableAutomaticScroll
            extraScrollHeight={24}
            keyboardOpeningTime={0}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 24 }}
          >
            <CreateForm />
          </KeyboardAwareScrollView>
        )}

        {tab === 'activas' && (
          activeItems.length === 0 ? (
            <Text style={styles.empty}>No tienes alarmas o temporizadores activos.</Text>
          ) : (
            <FlatList
              data={activeItems}
              keyExtractor={(i) => i.id}
              renderItem={({ item }) => <ItemRow item={item} />}
              contentContainerStyle={{ gap: 12 }}
            />
          )
        )}

        {tab === 'historial' && (
          historyItems.length === 0 ? (
            <Text style={styles.empty}>Aún no hay historial.</Text>
          ) : (
            <FlatList
              data={historyItems}
              keyExtractor={(i) => i.id + i.firedAt}
              renderItem={({ item }) => (
                <View style={styles.historyRow}>
                  <Text style={styles.itemTitle}>{item.type === 'alarm' ? 'Alarma' : 'Temporizador'} • {new Date(item.firedAt).toLocaleString()}</Text>
                  {!!item.label && <Text style={styles.itemSubtitle}>{item.label}</Text>}
                  {!!item.snoozes && item.snoozes > 0 && (
                    <Text style={styles.itemMeta}>Pospuestos: {item.snoozes}</Text>
                  )}
                </View>
              )}
              contentContainerStyle={{ gap: 12 }}
            />
          )
        )}
      </View>

      {/* Ringing modal (Android usa pantalla nativa) */}
      {Platform.OS !== 'android' && (
        <Modal visible={!!ringingItem} transparent animationType="slide">
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>{ringingItem?.type === 'alarm' ? '⏰ Alarma' : '⏲️ Temporizador'}</Text>
              {!!ringingItem?.label && <Text style={styles.modalSubtitle}>{ringingItem?.label}</Text>}
              <View style={styles.rowBetween}>
                {[5, 10, 15].map(m => (
                  <Pressable key={m} style={styles.snoozeButton} onPress={() => onSnooze(m)}>
                    <Text style={styles.snoozeButtonText}>Posponer {m}m</Text>
                  </Pressable>
                ))}
              </View>
              <Pressable style={styles.dismissButton} onPress={onDismiss}>
                <Text style={styles.dismissButtonText}>Desactivar</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      )}

      {/* Edit modal */}
      <Modal visible={!!editing} transparent animationType="fade" onRequestClose={() => setEditing(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Editar {editing?.type === 'alarm' ? 'alarma' : 'temporizador'}</Text>
            <Text style={styles.label}>Texto</Text>
            <TextInput style={styles.input} value={editLabel} onChangeText={setEditLabel} />
            {editing?.type === 'alarm' && (
              <View>
                <Text style={styles.label}>Fecha y hora</Text>
                <View style={styles.row}>
                  <Pressable style={styles.pickerButton} onPress={() => setEditShowDate(true)}>
                    <Text style={styles.pickerButtonText}>{editDate.toLocaleDateString()}</Text>
                  </Pressable>
                  <Pressable style={styles.pickerButton} onPress={() => setEditShowTime(true)}>
                    <Text style={styles.pickerButtonText}>{editDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
                  </Pressable>
                </View>
                {editShowDate && (
                  <DateTimePicker
                    value={editDate}
                    mode="date"
                    display="default"
                    onChange={(_, d) => {
                      setEditShowDate(false);
                      if (d) {
                        const nd = new Date(editDate);
                        nd.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
                        setEditDate(nd);
                      }
                    }}
                  />
                )}
                {editShowTime && (
                  <DateTimePicker
                    value={editDate}
                    mode="time"
                    is24Hour
                    display="default"
                    onChange={(_, d) => {
                      setEditShowTime(false);
                      if (d) {
                        const nd = new Date(editDate);
                        nd.setHours(d.getHours(), d.getMinutes(), 0, 0);
                        setEditDate(nd);
                      }
                    }}
                  />
                )}
              </View>
            )}
            <View style={styles.row}>
              <Pressable style={[styles.secondaryButton, { flex: 1 }]} onPress={() => setEditing(null)}>
                <Text style={styles.secondaryButtonText}>Cancelar</Text>
              </Pressable>
              <Pressable style={[styles.primaryButton, { flex: 1 }]} onPress={confirmEdit}>
                <Text style={styles.primaryButtonText}>Guardar</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0d1b2a' },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, backgroundColor: '#0b1320' },
  headerTitle: { color: '#e0ecff', fontSize: 20, fontWeight: '700' },
  tabs: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 8, gap: 8, backgroundColor: '#0b1320' },
  tabButton: { paddingVertical: 10, paddingHorizontal: 14, backgroundColor: '#12243a', borderRadius: 10 },
  tabButtonActive: { backgroundColor: '#1b3a63' },
  tabButtonText: { color: '#a9c2eb', fontWeight: '600' },
  tabButtonTextActive: { color: '#e6f0ff' },
  content: { flex: 1, padding: 16, gap: 16 },
  switchRow: { flexDirection: 'row', backgroundColor: '#12243a', borderRadius: 12, padding: 4 },
  modeButton: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  modeButtonActive: { backgroundColor: '#1b3a63' },
  modeText: { color: '#9fb6d9', fontWeight: '600' },
  modeTextActive: { color: '#e6f0ff' },
  label: { color: '#cddbf2', marginBottom: 6, fontWeight: '600' },
  input: { backgroundColor: '#12243a', color: '#e6f0ff', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  pickerButton: { backgroundColor: '#12243a', paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10 },
  pickerButtonText: { color: '#e6f0ff', fontWeight: '600' },
  chip: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 999, backgroundColor: '#12243a' },
  chipActive: { backgroundColor: '#1b3a63' },
  chipText: { color: '#a9c2eb', fontWeight: '600' },
  chipTextActive: { color: '#e6f0ff' },
  primaryButton: { backgroundColor: '#2a5ea9', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryButtonText: { color: '#e6f0ff', fontWeight: '700' },
  secondaryButton: { backgroundColor: '#12243a', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, marginRight: 8 },
  secondaryButtonText: { color: '#cddbf2', fontWeight: '700' },
  dangerButton: { backgroundColor: '#6b1d1d', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, marginLeft: 8 },
  dangerButtonText: { color: '#ffdfe0', fontWeight: '700' },
  itemRow: { backgroundColor: '#0b1320', borderRadius: 12, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'center' },
  itemTitle: { color: '#e6f0ff', fontWeight: '700' },
  itemSubtitle: { color: '#a9c2eb' },
  itemMeta: { color: '#9fb6d9', marginTop: 4 },
  historyRow: { backgroundColor: '#0b1320', borderRadius: 12, padding: 12 },
  empty: { color: '#9fb6d9', textAlign: 'center', marginTop: 24 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  modalCard: { width: '90%', backgroundColor: '#0b1320', borderRadius: 16, padding: 16, gap: 12 },
  modalTitle: { color: '#e6f0ff', fontSize: 20, fontWeight: '800' },
  modalSubtitle: { color: '#a9c2eb', marginBottom: 8 },
  snoozeButton: { backgroundColor: '#1b3a63', paddingVertical: 12, paddingHorizontal: 10, borderRadius: 10, flex: 1, alignItems: 'center' },
  snoozeButtonText: { color: '#e6f0ff', fontWeight: '700' },
  dismissButton: { backgroundColor: '#6b1d1d', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  dismissButtonText: { color: '#ffdfe0', fontWeight: '800' },
  slider: { height: 48 },
});
