/**
 * The PowerShell payload we execute to read the default audio render endpoint.
 *
 * Why PowerShell + embedded C#?
 *   - Core Audio (IMMDeviceEnumerator) is the *only* reliable way Windows
 *     exposes the current default endpoint; WMI's Win32_SoundDevice does NOT
 *     identify the default.
 *   - Embedding C# via Add-Type lets us call those COM interfaces from a
 *     Node.js plugin without shipping a compiled native addon.
 *   - Compared to a node-gyp / N-API addon: zero build step, zero ABI risk
 *     when Stream Deck swaps Node versions, no event-loop drain edge cases.
 *
 * The script writes either:
 *   OK<TAB>Device Friendly Name
 * or:
 *   ERR<TAB>Reason
 *
 * to stdout. We parse on the Node side.
 */

export const POWERSHELL_DETECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace DefaultAudioPlugin {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        int NotImpl1();
        [PreserveSig]
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        int NotImpl1();
        [PreserveSig]
        int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
        [PreserveSig]
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        [PreserveSig]
        int GetState(out int pdwState);
    }

    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        int GetCount(out int cProps);
        int GetAt(int iProp, out PROPERTYKEY pkey);
        [PreserveSig]
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public int  pid;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public short  vt;
        [FieldOffset(8)] public IntPtr pwszVal;
    }

    public static class Resolver {
        // PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
        static readonly Guid PKEY_FRIENDLY_FMTID =
            new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
        const int PKEY_FRIENDLY_PID = 14;

        // dataFlow: eRender = 0; role: eMultimedia = 1, eConsole = 0
        public static string GetDefaultRenderName(int role) {
            object enumObj = Activator.CreateInstance(
                Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
            IMMDeviceEnumerator e = (IMMDeviceEnumerator)enumObj;
            IMMDevice device;
            int hr = e.GetDefaultAudioEndpoint(0, role, out device);
            if (hr != 0) throw new Exception("GetDefaultAudioEndpoint hr=0x" + hr.ToString("X8"));

            IPropertyStore store;
            hr = device.OpenPropertyStore(0, out store);
            if (hr != 0) throw new Exception("OpenPropertyStore hr=0x" + hr.ToString("X8"));

            PROPERTYKEY key;
            key.fmtid = PKEY_FRIENDLY_FMTID;
            key.pid   = PKEY_FRIENDLY_PID;

            PROPVARIANT pv;
            hr = store.GetValue(ref key, out pv);
            if (hr != 0) throw new Exception("GetValue hr=0x" + hr.ToString("X8"));

            string name = Marshal.PtrToStringUni(pv.pwszVal);
            Marshal.ReleaseComObject(store);
            Marshal.ReleaseComObject(device);
            Marshal.ReleaseComObject(enumObj);
            return name;
        }
    }
}
'@ -ReferencedAssemblies 'System.Core'

    # Try eConsole (0) first - the most user-facing default. Fall back to eMultimedia (1).
    $name = $null
    try { $name = [DefaultAudioPlugin.Resolver]::GetDefaultRenderName(0) } catch { }
    if ([string]::IsNullOrWhiteSpace($name)) {
        $name = [DefaultAudioPlugin.Resolver]::GetDefaultRenderName(1)
    }

    $TAB = [char]9
    if ([string]::IsNullOrWhiteSpace($name)) {
        Write-Output ("ERR" + $TAB + "Empty device name")
    } else {
        # Use a TAB delimiter so device names with any character pass through unmangled.
        Write-Output ("OK" + $TAB + $name)
    }
} catch {
    Write-Output ("ERR" + [char]9 + $_.Exception.Message)
}
`;
