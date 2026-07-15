/**
 * Long-running PowerShell payload that registers an IMMNotificationClient
 * with the Windows Core Audio MMDeviceEnumerator and writes one line to
 * stdout per change event. The Node parent reads those lines and triggers
 * a refresh — no polling required.
 *
 * Output protocol (tab-delimited, one line per event):
 *   READY                                    after registration succeeds
 *   DEFAULT<TAB>flow<TAB>role<TAB>deviceId   default endpoint changed
 *   ADDED<TAB>deviceId                       device added
 *   REMOVED<TAB>deviceId                     device removed
 *   STATE<TAB>deviceId<TAB>newState          device state changed
 *   RESULT<TAB>id<TAB>OK|ERR<TAB>base64      command response
 *   ERR<TAB>reason                           fatal startup error
 *
 * The script accepts GET_DEFAULT_RENDER<TAB>id and STOP on stdin. Closing
 * stdin also shuts it down cleanly and unregisters the callback.
 */

export const POWERSHELL_WATCHER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace DefaultAudioPlugin {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject { }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public int  pid;
    }

    [Guid("7991EEC9-7E89-4D85-8390-6C703CEC60C0"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMNotificationClient {
        [PreserveSig] int OnDeviceStateChanged(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceId, uint newState);
        [PreserveSig] int OnDeviceAdded(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceId);
        [PreserveSig] int OnDeviceRemoved(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceId);
        [PreserveSig] int OnDefaultDeviceChanged(
            int flow, int role,
            [MarshalAs(UnmanagedType.LPWStr)] string defaultDeviceId);
        [PreserveSig] int OnPropertyValueChanged(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceId, PROPERTYKEY key);
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceId, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IMMNotificationClient client);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IMMNotificationClient client);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, out IntPtr result);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string deviceId);
        [PreserveSig] int GetState(out int state);
    }

    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        int GetCount(out int count);
        int GetAt(int index, out PROPERTYKEY key);
        [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public short vt;
        [FieldOffset(8)] public IntPtr pwszVal;
    }

    public class NotificationClient : IMMNotificationClient {
        // System.Console.Out is shared and not guaranteed thread-safe under
        // arbitrary concurrent COM callbacks, so serialize.
        private static readonly object _lock = new object();

        public static void Emit(string line) {
            lock (_lock) {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
        }

        public int OnDeviceStateChanged(string deviceId, uint newState) {
            try { Emit("STATE\t" + (deviceId ?? "") + "\t" + newState); } catch { }
            return 0;
        }
        public int OnDeviceAdded(string deviceId) {
            try { Emit("ADDED\t" + (deviceId ?? "")); } catch { }
            return 0;
        }
        public int OnDeviceRemoved(string deviceId) {
            try { Emit("REMOVED\t" + (deviceId ?? "")); } catch { }
            return 0;
        }
        public int OnDefaultDeviceChanged(int flow, int role, string defaultDeviceId) {
            try { Emit("DEFAULT\t" + flow + "\t" + role + "\t" + (defaultDeviceId ?? "")); } catch { }
            return 0;
        }
        public int OnPropertyValueChanged(string deviceId, PROPERTYKEY key) {
            // Not interested — the friendly name change comes through OnDefault*
            // via the role/flow path, and property events fire on a hot path.
            return 0;
        }
    }

    public static class Watcher {
        static readonly Guid PKEY_FRIENDLY_FMTID =
            new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
        const int PKEY_FRIENDLY_PID = 14;

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PROPVARIANT value);

        static string Encode(string value) {
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? ""));
        }

        static string GetDefaultRenderName(IMMDeviceEnumerator enumerator) {
            try {
                return GetDefaultRenderName(enumerator, 0);
            } catch {
                return GetDefaultRenderName(enumerator, 1);
            }
        }

        static string GetDefaultRenderName(IMMDeviceEnumerator enumerator, int role) {
            IMMDevice device = null;
            IPropertyStore store = null;
            PROPVARIANT value = new PROPVARIANT();
            try {
                int hr = enumerator.GetDefaultAudioEndpoint(0, role, out device);
                if (hr != 0 || device == null) {
                    throw new Exception("GetDefaultAudioEndpoint hr=0x" + hr.ToString("X8"));
                }

                hr = device.OpenPropertyStore(0, out store);
                if (hr != 0 || store == null) {
                    throw new Exception("OpenPropertyStore hr=0x" + hr.ToString("X8"));
                }

                PROPERTYKEY key;
                key.fmtid = PKEY_FRIENDLY_FMTID;
                key.pid = PKEY_FRIENDLY_PID;
                hr = store.GetValue(ref key, out value);
                if (hr != 0) throw new Exception("GetValue hr=0x" + hr.ToString("X8"));

                string name = value.pwszVal == IntPtr.Zero
                    ? ""
                    : Marshal.PtrToStringUni(value.pwszVal);
                if (String.IsNullOrWhiteSpace(name)) throw new Exception("Empty device name");
                return name;
            } finally {
                try { PropVariantClear(ref value); } catch { }
                if (store != null) try { Marshal.ReleaseComObject(store); } catch { }
                if (device != null) try { Marshal.ReleaseComObject(device); } catch { }
            }
        }

        public static void Run() {
            object enumObj = Activator.CreateInstance(
                Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
            IMMDeviceEnumerator e = (IMMDeviceEnumerator)enumObj;
            NotificationClient client = new NotificationClient();

            int hr = e.RegisterEndpointNotificationCallback(client);
            if (hr != 0) {
                try { Marshal.ReleaseComObject(enumObj); } catch { }
                throw new Exception("RegisterEndpointNotificationCallback hr=0x" + hr.ToString("X8"));
            }

            try {
                Console.Out.WriteLine("READY");
                Console.Out.Flush();

                // Handle parent commands until stdin closes or STOP is sent.
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    if (line == "STOP") break;
                    string[] parts = line.Split(new char[] { '\t' }, 3);
                    if (parts.Length >= 2 && parts[0] == "GET_DEFAULT_RENDER") {
                        string requestId = parts[1];
                        try {
                            string name = GetDefaultRenderName(e);
                            NotificationClient.Emit(
                                "RESULT\t" + requestId + "\tOK\t" + Encode(name));
                        } catch (Exception ex) {
                            NotificationClient.Emit(
                                "RESULT\t" + requestId + "\tERR\t" + Encode(ex.Message));
                        }
                    }
                }
            } finally {
                try { e.UnregisterEndpointNotificationCallback(client); } catch { }
                try { Marshal.ReleaseComObject(enumObj); } catch { }
            }
        }
    }
}
'@ -ReferencedAssemblies 'System.Core'

    [DefaultAudioPlugin.Watcher]::Run()
} catch {
    $TAB = [char]9
    Write-Output ("ERR" + $TAB + $_.Exception.Message)
}
`;
