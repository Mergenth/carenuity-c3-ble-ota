// Adds the Bluetooth permissions the Capacitor BLE plugin needs to the
// generated native projects. Run by `npm run native:android` / `native:ios`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const target = process.argv[2];

function patch(file, edit) {
  if (!existsSync(file)) {
    console.error(`native-setup: ${file} not found. Run "npx cap add ${target}" first.`);
    process.exit(1);
  }
  const before = readFileSync(file, 'utf8');
  const after = edit(before);
  if (after !== before) writeFileSync(file, after);
  console.log(`native-setup: ${file} ${after === before ? 'already up to date' : 'updated'}`);
}

if (target === 'android') {
  patch('android/app/src/main/AndroidManifest.xml', (xml) => {
    if (xml.includes('android.permission.BLUETOOTH_SCAN')) return xml;
    const permissions = `
    <!-- Bluetooth LE: Android 12 and newer -->
    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <!-- Bluetooth LE: Android 11 and older -->
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />
    <uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
`;
    return xml.replace(/\n<\/manifest>/, `${permissions}</manifest>`);
  });
} else if (target === 'ios') {
  patch('ios/App/App/Info.plist', (plist) => {
    if (plist.includes('NSBluetoothAlwaysUsageDescription')) return plist;
    const keys = `	<key>NSBluetoothAlwaysUsageDescription</key>
	<string>Bluetooth is used to send apps to your Carenuity board.</string>
`;
    return plist.replace(/<\/dict>\s*<\/plist>\s*$/, `${keys}</dict>\n</plist>\n`);
  });
} else {
  console.error('usage: node scripts/native-setup.mjs android|ios');
  process.exit(1);
}
