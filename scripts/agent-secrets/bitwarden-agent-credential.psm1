# Stores Bitwarden Secrets Manager machine-account tokens for agent lanes in
# Windows Credential Manager (DPAPI-protected, current user, this machine only).
# The credential UserName holds the non-secret project ID; the blob holds the
# access token. Any process running as this Windows user can read it, so the
# token's Bitwarden-side scope (read-only, one project, expiry) is the real
# boundary.
Set-StrictMode -Version Latest

if (-not ('ChaseSets.AgentCredentialStore' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace ChaseSets {
  public static class AgentCredentialStore {
    private const int CRED_TYPE_GENERIC = 1;
    private const int CRED_PERSIST_LOCAL_MACHINE = 2;
    private const int ERROR_NOT_FOUND = 1168;
    private const int CRED_MAX_CREDENTIAL_BLOB_SIZE = 2560;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
      public int Flags;
      public int Type;
      public string TargetName;
      public string Comment;
      public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
      public int CredentialBlobSize;
      public IntPtr CredentialBlob;
      public int Persist;
      public int AttributeCount;
      public IntPtr Attributes;
      public string TargetAlias;
      public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref CREDENTIAL credential, int flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, int type, int flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    public static void Write(string target, string userName, string secret, string comment) {
      byte[] bytes = Encoding.UTF8.GetBytes(secret);
      if (bytes.Length == 0 || bytes.Length > CRED_MAX_CREDENTIAL_BLOB_SIZE) {
        throw new ArgumentException("secret must be between 1 and " + CRED_MAX_CREDENTIAL_BLOB_SIZE + " bytes");
      }
      IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
      try {
        Marshal.Copy(bytes, 0, blob, bytes.Length);
        CREDENTIAL credential = new CREDENTIAL {
          Type = CRED_TYPE_GENERIC,
          TargetName = target,
          UserName = userName,
          Comment = comment,
          CredentialBlobSize = bytes.Length,
          CredentialBlob = blob,
          Persist = CRED_PERSIST_LOCAL_MACHINE
        };
        if (!CredWrite(ref credential, 0)) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
      } finally {
        Marshal.Copy(new byte[bytes.Length], 0, blob, bytes.Length);
        Marshal.FreeHGlobal(blob);
        Array.Clear(bytes, 0, bytes.Length);
      }
    }

    // Returns null when absent, otherwise { userName, secret }.
    public static string[] Read(string target) {
      IntPtr buffer;
      if (!CredRead(target, CRED_TYPE_GENERIC, 0, out buffer)) {
        int error = Marshal.GetLastWin32Error();
        if (error == ERROR_NOT_FOUND) { return null; }
        throw new Win32Exception(error);
      }
      byte[] bytes = new byte[0];
      try {
        CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(buffer, typeof(CREDENTIAL));
        bytes = new byte[credential.CredentialBlobSize];
        if (bytes.Length > 0) { Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length); }
        return new string[] { credential.UserName, Encoding.UTF8.GetString(bytes) };
      } finally {
        Array.Clear(bytes, 0, bytes.Length);
        CredFree(buffer);
      }
    }

    public static bool Delete(string target) {
      if (CredDelete(target, CRED_TYPE_GENERIC, 0)) { return true; }
      int error = Marshal.GetLastWin32Error();
      if (error == ERROR_NOT_FOUND) { return false; }
      throw new Win32Exception(error);
    }
  }
}
"@
}

function Get-AgentCredentialTarget {
  param([Parameter(Mandatory)][string]$Account)
  if ($Account -cnotmatch '^[a-z0-9][a-z0-9-]{0,62}$') {
    throw "Invalid account '$Account': use lowercase letters, digits, and hyphens."
  }
  "chase-sets/bws/$Account"
}

function Set-AgentBwsCredential {
  param(
    [Parameter(Mandatory)][string]$Account,
    [Parameter(Mandatory)][guid]$ProjectId,
    [Parameter(Mandatory)][securestring]$AccessToken
  )
  $plain = [Net.NetworkCredential]::new('', $AccessToken).Password
  try {
    [ChaseSets.AgentCredentialStore]::Write((Get-AgentCredentialTarget $Account), $ProjectId.ToString(), $plain, 'Bitwarden Secrets Manager machine-account token for chase-sets agents')
  } finally {
    $plain = $null
  }
}

function Get-AgentBwsCredential {
  param([Parameter(Mandatory)][string]$Account)
  $target = Get-AgentCredentialTarget $Account
  $entry = [ChaseSets.AgentCredentialStore]::Read($target)
  if ($null -eq $entry) { return $null }
  $projectId = [guid]::Empty
  if (-not [guid]::TryParse($entry[0], [ref]$projectId)) {
    throw "Credential '$target' does not hold a project ID; rerun scripts/agent-secrets/set-bitwarden-agent-token.ps1."
  }
  [pscustomobject]@{ Target = $target; ProjectId = $projectId; AccessToken = $entry[1] }
}

function Remove-AgentBwsCredential {
  param([Parameter(Mandatory)][string]$Account)
  [ChaseSets.AgentCredentialStore]::Delete((Get-AgentCredentialTarget $Account))
}

Export-ModuleMember -Function Get-AgentCredentialTarget, Set-AgentBwsCredential, Get-AgentBwsCredential, Remove-AgentBwsCredential
