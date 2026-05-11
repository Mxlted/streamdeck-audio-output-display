/**
 * PowerShell payload for setting the default Windows audio endpoint.
 *
 * The public Windows Core Audio API can enumerate endpoints, but setting the
 * default endpoint uses the long-standing IPolicyConfig COM interface. We set
 * all three roles so the chosen device becomes both the normal default and the
 * communications default.
 */

export const POWERSHELL_SET_DEFAULT_SCRIPT = String.raw`
param(
    [ValidateSet('List', 'Set')]
    [string]$Mode = 'Set',

    [Parameter(Mandatory=$true)]
    [ValidateSet('render', 'capture')]
    [string]$Flow,

    [string]$TargetName = '',
    [string]$FallbackId = ''
)

$ErrorActionPreference = 'Stop'
try {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace DefaultAudioSetterPlugin {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        [PreserveSig]
        int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
        [PreserveSig]
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceCollection {
        [PreserveSig]
        int GetCount(out uint pcDevices);
        [PreserveSig]
        int Item(uint nDevice, out IMMDevice ppDevice);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        [PreserveSig]
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface);
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

    [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
    public class PolicyConfigClient { }

    [Guid("F8679F50-850A-41CF-9C72-430F290290C8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPolicyConfig {
        int GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr ppFormat);
        int GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bDefault, IntPtr ppFormat);
        int ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName);
        int SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr pEndpointFormat, IntPtr pMixFormat);
        int GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
        int SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr pmftPeriod);
        int GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr pMode);
        int SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, IntPtr mode);
        int GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, ref PROPERTYKEY key, out PROPVARIANT pv);
        int SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, ref PROPERTYKEY key, ref PROPVARIANT pv);
        int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int role);
        int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int bVisible);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public int pid;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public short vt;
        [FieldOffset(8)] public IntPtr pwszVal;
    }

    public class Endpoint {
        public string Id;
        public string Name;
        public string MatchedBy;
    }

    public static class Setter {
        static readonly Guid PKEY_FRIENDLY_FMTID =
            new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
        const int PKEY_FRIENDLY_PID = 14;
        const int DEVICE_STATE_ACTIVE = 0x00000001;

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PROPVARIANT pvar);

        public static string SetDefault(string flowName, string targetName, string fallbackId) {
            int flow = String.Equals(flowName, "capture", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
            List<Endpoint> endpoints = EnumerateActiveEndpoints(flow);
            Endpoint endpoint = ResolveEndpoint(endpoints, targetName, fallbackId);
            SetEndpointForAllRoles(endpoint.Id);
            return endpoint.Name + "\t" + endpoint.Id + "\t" + endpoint.MatchedBy;
        }

        public static Endpoint[] ListDevices(string flowName) {
            int flow = String.Equals(flowName, "capture", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
            return EnumerateActiveEndpoints(flow).ToArray();
        }

        static List<Endpoint> EnumerateActiveEndpoints(int flow) {
            object enumObj = null;
            IMMDeviceCollection collection = null;
            List<Endpoint> endpoints = new List<Endpoint>();

            try {
                enumObj = Activator.CreateInstance(
                    Type.GetTypeFromCLSID(new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")));
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)enumObj;

                int hr = enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, out collection);
                if (hr != 0) throw new Exception("EnumAudioEndpoints hr=0x" + hr.ToString("X8"));

                uint count;
                hr = collection.GetCount(out count);
                if (hr != 0) throw new Exception("GetCount hr=0x" + hr.ToString("X8"));

                for (uint i = 0; i < count; i++) {
                    IMMDevice device = null;
                    try {
                        hr = collection.Item(i, out device);
                        if (hr != 0 || device == null) continue;

                        string id;
                        hr = device.GetId(out id);
                        if (hr != 0 || String.IsNullOrWhiteSpace(id)) continue;

                        string name = GetFriendlyName(device);
                        if (!String.IsNullOrWhiteSpace(name)) {
                            endpoints.Add(new Endpoint { Id = id, Name = name, MatchedBy = "" });
                        }
                    } finally {
                        if (device != null) Marshal.ReleaseComObject(device);
                    }
                }
            } finally {
                if (collection != null) Marshal.ReleaseComObject(collection);
                if (enumObj != null) Marshal.ReleaseComObject(enumObj);
            }

            if (endpoints.Count == 0) {
                throw new Exception("No active " + (flow == 1 ? "input" : "output") + " endpoints found");
            }
            return endpoints;
        }

        static string GetFriendlyName(IMMDevice device) {
            IPropertyStore store = null;
            PROPVARIANT pv = new PROPVARIANT();
            try {
                int hr = device.OpenPropertyStore(0, out store);
                if (hr != 0) throw new Exception("OpenPropertyStore hr=0x" + hr.ToString("X8"));

                PROPERTYKEY key;
                key.fmtid = PKEY_FRIENDLY_FMTID;
                key.pid = PKEY_FRIENDLY_PID;

                hr = store.GetValue(ref key, out pv);
                if (hr != 0) throw new Exception("GetValue hr=0x" + hr.ToString("X8"));
                if (pv.pwszVal == IntPtr.Zero) return "";

                return Marshal.PtrToStringUni(pv.pwszVal);
            } finally {
                try { PropVariantClear(ref pv); } catch { }
                if (store != null) Marshal.ReleaseComObject(store);
            }
        }

        static Endpoint ResolveEndpoint(List<Endpoint> endpoints, string targetName, string fallbackId) {
            targetName = (targetName ?? "").Trim();
            fallbackId = (fallbackId ?? "").Trim();

            Endpoint fallback = null;
            if (!String.IsNullOrWhiteSpace(fallbackId)) {
                foreach (Endpoint endpoint in endpoints) {
                    if (String.Equals(endpoint.Id, fallbackId, StringComparison.OrdinalIgnoreCase)) {
                        fallback = endpoint;
                        break;
                    }
                }
            }

            Endpoint best = null;
            int bestScore = 0;
            if (!String.IsNullOrWhiteSpace(targetName)) {
                foreach (Endpoint endpoint in endpoints) {
                    int score = MatchScore(endpoint.Name, targetName);
                    if (score <= 0) continue;

                    bool idTieBreak =
                        score == bestScore &&
                        fallback != null &&
                        String.Equals(endpoint.Id, fallback.Id, StringComparison.OrdinalIgnoreCase);

                    if (score > bestScore || idTieBreak) {
                        best = endpoint;
                        bestScore = score;
                    }
                }
            }

            if (best != null) {
                best.MatchedBy = MatchLabel(bestScore);
                if (fallback != null && String.Equals(best.Id, fallback.Id, StringComparison.OrdinalIgnoreCase)) {
                    best.MatchedBy += "+fallback-id";
                }
                return best;
            }

            if (fallback != null) {
                fallback.MatchedBy = "fallback-id";
                return fallback;
            }

            string needle = String.IsNullOrWhiteSpace(targetName) ? fallbackId : targetName;
            throw new Exception("No active endpoint matched \"" + needle + "\". Active endpoints: " + JoinEndpointNames(endpoints));
        }

        static int MatchScore(string candidate, string target) {
            if (String.Equals(candidate, target, StringComparison.OrdinalIgnoreCase)) return 100;

            string normalizedCandidate = NormalizeName(candidate);
            string normalizedTarget = NormalizeName(target);
            if (String.IsNullOrWhiteSpace(normalizedCandidate) || String.IsNullOrWhiteSpace(normalizedTarget)) return 0;
            if (String.Equals(normalizedCandidate, normalizedTarget, StringComparison.OrdinalIgnoreCase)) return 90;

            if (candidate.IndexOf(target, StringComparison.OrdinalIgnoreCase) >= 0) return 75;
            if (target.IndexOf(candidate, StringComparison.OrdinalIgnoreCase) >= 0) return 70;
            if (normalizedCandidate.IndexOf(normalizedTarget, StringComparison.OrdinalIgnoreCase) >= 0) return 65;
            if (normalizedTarget.IndexOf(normalizedCandidate, StringComparison.OrdinalIgnoreCase) >= 0) return 60;
            return 0;
        }

        static string MatchLabel(int score) {
            if (score >= 100) return "exact-name";
            if (score >= 90) return "normalized-name";
            if (score >= 70) return "contains-name";
            return "normalized-contains";
        }

        static string NormalizeName(string value) {
            if (String.IsNullOrWhiteSpace(value)) return "";
            string normalized = value.Trim().ToLowerInvariant();
            normalized = Regex.Replace(normalized, @"^\d+\-\s*", "");
            normalized = normalized.Replace("(r)", "");
            normalized = normalized.Replace("(tm)", "");
            normalized = normalized.Replace("\u00AE", "");
            normalized = normalized.Replace("\u2122", "");
            normalized = Regex.Replace(normalized, @"\s+", " ");
            return normalized.Trim();
        }

        static string JoinEndpointNames(List<Endpoint> endpoints) {
            List<string> names = new List<string>();
            foreach (Endpoint endpoint in endpoints) {
                names.Add(endpoint.Name);
                if (names.Count >= 8) break;
            }
            return String.Join(", ", names.ToArray());
        }

        static void SetEndpointForAllRoles(string endpointId) {
            object policyObj = null;
            try {
                policyObj = Activator.CreateInstance(
                    Type.GetTypeFromCLSID(new Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")));
                IPolicyConfig policy = (IPolicyConfig)policyObj;

                for (int role = 0; role <= 2; role++) {
                    int hr = policy.SetDefaultEndpoint(endpointId, role);
                    if (hr != 0) {
                        throw new Exception("SetDefaultEndpoint role=" + role + " hr=0x" + hr.ToString("X8"));
                    }
                }
            } finally {
                if (policyObj != null) Marshal.ReleaseComObject(policyObj);
            }
        }
    }
}
'@ -ReferencedAssemblies 'System.Core'

    $TAB = [char]9
    if ($Mode -eq 'List') {
        $devices = [DefaultAudioSetterPlugin.Setter]::ListDevices($Flow) |
            ForEach-Object { [pscustomobject]@{ id = $_.Id; name = $_.Name } }
        $json = ConvertTo-Json -Compress -Depth 3 -InputObject @($devices)
        if ([string]::IsNullOrWhiteSpace($json)) { $json = '[]' }
        Write-Output ("OK" + $TAB + $json)
    } else {
        $result = [DefaultAudioSetterPlugin.Setter]::SetDefault($Flow, $TargetName, $FallbackId)
        Write-Output ("OK" + $TAB + $result)
    }
} catch {
    Write-Output ("ERR" + [char]9 + $_.Exception.Message)
}
`;
