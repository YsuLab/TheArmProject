/*
  Blind-assist glove — firmware logic for the Wokwi ESP32 simulator.
  https://wokwi.com  (create a new ESP32 Arduino project and paste this in)

  Stand-ins used in simulation:
    5 LEDs (+220 ohm)  -> the 5 vibration motors (brightness = vibration strength)
    Potentiometer A    -> IR object temperature   (maps to -10 .. 120 C)
    Potentiometer B    -> palm-side ToF distance  (maps to 2 .. 60 cm)
    Push button        -> IMU "palm up / palm down" flip
    Serial Monitor     -> cues from the shoulder hub (type l, r, s, f, x)

  Wiring:
    LEDs (thumb..pinky): GPIO 4, 5, 18, 19, 21 -> resistor -> GND
    Pot A wiper: GPIO 34   Pot B wiper: GPIO 35  (pot ends to 3V3 and GND)
    Button: GPIO 23 to GND (internal pull-up)

  On real hardware: swap LEDs for motor transistors + flyback diodes,
  potentiometers for MLX90614 / VL53L0X readings, button for the IMU.

  Priority: HEAT/COLD (local, imminent contact) > STOP > LEFT/RIGHT > FORWARD tick.
*/

const bool RIGHT_HAND = true;                 // set per user (open question: which hand?)
const int  MOTOR[5]   = {4, 5, 18, 19, 21};   // thumb, index, middle, ring, pinky
const int  POT_TEMP = 34, POT_DIST = 35, BTN_FLIP = 23;

const float HOT_C   = 50.0;   // tune with real cookware
const float COLD_C  = 5.0;
const float WARN_CM = 30.0;   // start warning within this distance
const float MIN_CM  = 3.0;
const int   MIN_DUTY = 80;    // weakest perceptible vibration (tune on real motors)

enum Cue { CUE_NONE, CUE_LEFT, CUE_RIGHT, CUE_STOP, CUE_FORWARD };
Cue hubCue = CUE_NONE;
unsigned long cueStart = 0;
const unsigned long CUE_TIMEOUT_MS = 1500;    // a stale hub cue is dropped

bool palmDown = true;
unsigned long lastBtn = 0;

void setOne(int motor, int duty) { analogWrite(MOTOR[motor], duty); }
void setAll(int duty) { for (int i = 0; i < 5; i++) setOne(i, duty); }

// Motor index at physical position k (0 = user's leftmost finger, 4 = rightmost).
int physicalToMotor(int k) {
  bool thumbOnLeft = (RIGHT_HAND == palmDown);
  return thumbOnLeft ? k : 4 - k;
}

int dutyFromDistance(float cm) {
  float s = (WARN_CM - cm) / (WARN_CM - MIN_CM);
  s = constrain(s, 0.0, 1.0);
  return MIN_DUTY + (int)(s * (255 - MIN_DUTY));
}

void patternHot(unsigned long t, int duty) {            // fast pulse, all fingers
  setAll(((t / 80) % 2 == 0) ? duty : 0);
}

void patternCold(unsigned long t, int duty) {           // slow rolling wave
  for (int k = 0; k < 5; k++) {
    float phase = (t % 1200) / 1200.0 * 2 * PI - k * 0.9;
    float v = (sin(phase) + 1) / 2;
    setOne(physicalToMotor(k), (int)(v * duty));
  }
}

void patternStop(unsigned long t) {                     // two long pulses, then a gap
  unsigned long p = t % 1400;
  bool on = (p < 300) || (p >= 450 && p < 750);
  setAll(on ? 255 : 0);
}

void patternSweep(unsigned long t, bool towardRight, int duty) {
  int step = (t / 90) % 8;                              // 5 steps + 3 steps pause
  setAll(0);
  if (step < 5) {
    int k = towardRight ? step : 4 - step;
    setOne(physicalToMotor(k), duty);
  }
}

void patternForward(unsigned long t) {                  // short tick on the middle finger
  setAll(0);
  if (t % 1500 < 60) setOne(2, 140);
}

void readSerial() {
  while (Serial.available()) {
    char c = tolower(Serial.read());
    Cue next = hubCue;
    if (c == 'l') next = CUE_LEFT;
    else if (c == 'r') next = CUE_RIGHT;
    else if (c == 's') next = CUE_STOP;
    else if (c == 'f') next = CUE_FORWARD;
    else if (c == 'x') next = CUE_NONE;
    else continue;
    hubCue = next;
    cueStart = millis();
    Serial.printf("hub cue -> %c\n", c);
  }
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 5; i++) pinMode(MOTOR[i], OUTPUT);
  pinMode(BTN_FLIP, INPUT_PULLUP);
  Serial.println("Glove sim ready. Type l / r / s / f / x. Button flips palm orientation.");
  setAll(255); delay(400); setAll(0);                   // power-on confirmation buzz
}

void loop() {
  unsigned long t = millis();
  readSerial();

  if (digitalRead(BTN_FLIP) == LOW && t - lastBtn > 300) {
    palmDown = !palmDown;
    lastBtn = t;
    Serial.printf("palm %s\n", palmDown ? "DOWN" : "UP");
  }

  float tempC = map(analogRead(POT_TEMP), 0, 4095, -100, 1200) / 10.0;
  float distCm = map(analogRead(POT_DIST), 0, 4095, 20, 600) / 10.0;
  bool near = distCm < WARN_CM;

  if (hubCue != CUE_NONE && t - cueStart > CUE_TIMEOUT_MS) hubCue = CUE_NONE;

  if (near && tempC >= HOT_C)       patternHot(t, dutyFromDistance(distCm));
  else if (near && tempC <= COLD_C) patternCold(t, dutyFromDistance(distCm));
  else if (hubCue == CUE_STOP)      patternStop(t);
  else if (hubCue == CUE_LEFT)      patternSweep(t, false, 200);
  else if (hubCue == CUE_RIGHT)     patternSweep(t, true, 200);
  else if (hubCue == CUE_FORWARD)   patternForward(t);
  else                              setAll(0);

  delay(10);
}
