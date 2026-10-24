#!/bin/bash
# Runs DroneLink Mobile on an Android emulator: install, start, screenshots, crash check.
# No drone is connected, so this checks start-up, DJI sign-in and the screens only.
set -u
PKG=com.hksit.dronelink.mobile
OUT=ci-out
mkdir -p $OUT
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 2; done'
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0

APK=$(ls apk/*.apk | head -1)
echo "Installing $APK"
if ! adb install -r -g "$APK" > $OUT/install.txt 2>&1; then
  cat $OUT/install.txt
  echo "::error title=Install failed::$(tr '\n' ' ' < $OUT/install.txt)"
  exit 1
fi
echo "::notice title=Install::$(tr '\n' ' ' < $OUT/install.txt)"

adb logcat -c
adb shell am start -W -n $PKG/.MainActivity
sleep 25
adb exec-out screencap -p > $OUT/1-start.png

# tap a button by its text using the UI tree
tap() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  adb pull /sdcard/ui.xml $OUT/ui.xml >/dev/null 2>&1
  b=$(grep -o "text=\"$1\"[^>]*bounds=\"\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]\"" $OUT/ui.xml | grep -o 'bounds="[^"]*"' | head -1 | grep -o '[0-9]*')
  if [ -z "$b" ]; then echo "button '$1' not found"; return 1; fi
  set -- $b
  adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}

tap "I understand" && sleep 3
sleep 40   # time for the SDK to start and sign in to DJI
adb exec-out screencap -p > $OUT/2-main.png
tap "Settings" && sleep 4
adb exec-out screencap -p > $OUT/3-settings.png
adb shell input keyevent KEYCODE_BACK
sleep 2

# rotate the screen and come back: the app must survive it
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 3; sleep 4
adb shell settings put system user_rotation 1; sleep 6
adb exec-out screencap -p > $OUT/4-after-rotate.png

adb logcat -d > $OUT/logcat.txt
pid=$(adb shell pidof $PKG | tr -d '\r')
grep -E "FATAL EXCEPTION|AndroidRuntime: (FATAL|Process: $PKG)" -A12 $OUT/logcat.txt | head -60 > $OUT/crash.txt
if [ -s $OUT/crash.txt ]; then
  echo "::error title=App crashed::$(head -30 $OUT/crash.txt | sed 's/%/%25/g' | awk '{printf "%s%%0A", $0}')"
fi
if [ -z "$pid" ]; then echo "::error title=App not running::The app is not running at the end of the test"; else echo "::notice title=App running::pid $pid"; fi
grep -iE "DroneLink|register|SDKManager|DJISDK" $OUT/logcat.txt | grep -v "^--" | tail -25 > $OUT/sdk.txt || true
echo "::notice title=SDK log::$(tail -15 $OUT/sdk.txt | cut -c1-220 | sed 's/%/%25/g' | awk '{printf "%s%%0A", $0}')"
exit 0
