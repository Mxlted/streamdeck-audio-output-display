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
 *   ERR<TAB>reason                           fatal startup error
 *
 * The script blocks on stdin. Writing "STOP\n" (or closing stdin) shuts
 * it down cleanly, unregistering the callback before exit.
 */

export const POWERSHELL_WATCHER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

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
        // Slot 0: EnumAudioEndpoints (unused)
        int NotImpl0();
        // Slot 1: GetDefaultAudioEndpoint (unused here, kept for ABI alignment)
        int NotImpl1();
        // Slot 2: GetDevice (unused)
        int NotImpl2();
        // Slot 3: RegisterEndpointNotificationCallback
        [PreserveSig] int RegisterEndpointNotificationCallback(IMMNotificationClient client);
        // Slot 4: UnregisterEndpointNotificationCallback
        [PreserveSig] int UnregisterEndpointNotificationCallback(IMMNotificationClient client);
    }

    public class NotificationClient : IMMNotificationClient {
        // System.Console.Out is shared and not guaranteed thread-safe under
        // arbitrary concurrent COM callbacks, so serialize.
        private static readonly object _lock = new object();

        private static void Emit(string line) {
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

                // Block until parent closes stdin or sends "STOP".
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    if (line == "STOP") break;
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
