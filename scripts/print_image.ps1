param(
    [string]$printerName,
    [string]$imagePath,
    [string]$offsetXStr = "0", 
    [string]$offsetYStr = "0", 
    [string]$widthMmStr = "0", 
    [string]$heightMmStr = "0",
    [string]$orientation = "landscape",
    [string]$enable2x6 = "false",
    [string]$targetDpi = "300"
)

# Parse doubles safely regardless of System Locale (VN vs EN)
function Parse-Double($val) {
    if ([string]::IsNullOrEmpty($val)) { return 0 }
    return [double]::Parse($val.ToString().Replace(",", "."), [System.Globalization.CultureInfo]::InvariantCulture)
}

$offsetX = Parse-Double $offsetXStr
$offsetY = Parse-Double $offsetYStr
$widthMm = Parse-Double $widthMmStr
$heightMm = Parse-Double $heightMmStr
$is2x6 = if ($enable2x6 -eq "true") { $true } else { $false }
$dpiVal = [int]$targetDpi

Add-Type -AssemblyName System.Drawing

$printDoc = New-Object System.Drawing.Printing.PrintDocument

# --- 0. SMART PRINTER DETECTION ---
# If exact name doesn't exist, try partial match (e.g. "DS-RX1 Copy 1")
$installedPrinters = [System.Drawing.Printing.PrinterSettings]::InstalledPrinters
if ($installedPrinters -notcontains $printerName) {
    Write-Host "⚠️ Exact printer '$printerName' not found. Searching for fallback..."
    
    # Try finding any printer with "RX1" or "DNP" or "Citizen" or "CY"
    $fallback = $null
    foreach ($p in $installedPrinters) {
        if ($p -match "RX1" -or $p -match "DNP" -or $p -match "Citizen" -or $p -match "CY-02") {
            $fallback = $p
            break
        }
    }

    if ($fallback) {
        Write-Host "✅ Found fallback printer: '$fallback'"
        $printerName = $fallback
    }
    else {
        Write-Host "❌ FATAL: No compatible DNP/Citizen printer found!"
        exit 1
    }
}

$printDoc.PrinterSettings.PrinterName = $printerName

# --- 1. SET ORIENTATION ---
if ($orientation -eq "portrait") {
    $printDoc.DefaultPageSettings.Landscape = $false
    Write-Host "Orientation: Portrait"
}
else {
    $printDoc.DefaultPageSettings.Landscape = $true
    Write-Host "Orientation: Landscape"
}

# --- 2. SET RESOLUTION (DPI) ---
Write-Host "Searching for DPI: $dpiVal..."
$resolutions = $printDoc.PrinterSettings.PrinterResolutions
foreach ($res in $resolutions) {
    if ($res.Kind -ne "Custom") {
        if ($dpiVal -ge 600 -and ($res.X -ge 600 -or $res.Y -ge 600)) {
            $printDoc.DefaultPageSettings.PrinterResolution = $res
            Write-Host ">>> SET DPI: High ($($res.X)x$($res.Y))"
            break
        }
        elseif ($dpiVal -lt 600 -and $res.X -le 350) {
            $printDoc.DefaultPageSettings.PrinterResolution = $res
            Write-Host ">>> SET DPI: Standard ($($res.X)x$($res.Y))"
            break
        }
    }
}

# --- 3. CHECK & FORCE PAPER SIZE (With 2x6 Cut Support) ---
if ($widthMm -gt 0 -and $heightMm -gt 0) {
    $wHun = [math]::Round($widthMm / 25.4 * 100)
    $hHun = [math]::Round($heightMm / 25.4 * 100)
    
    $searchW = if ($wHun -lt $hHun) { $wHun } else { $hHun }
    $searchH = if ($wHun -lt $hHun) { $hHun } else { $wHun }

    Write-Host "Target: ${searchW}x${searchH} (1/100 inch). Cut 2x6 Mode: $is2x6"

    $sizes = $printDoc.PrinterSettings.PaperSizes
    $bestMatch = $null
    
    foreach ($s in $sizes) {
        $diffW = [math]::Abs($s.Width - $searchW)
        $diffH = [math]::Abs($s.Height - $searchH)

        # Check Dimension Match (Increased tolerance for DNP drivers)
        if ($diffW -lt 20 -and $diffH -lt 20) {
            # Refine by Name for 2x6 Cut
            if ($is2x6) {
                if ($s.PaperName.Contains("2x6") -or $s.PaperName.Contains("x2") -or $s.PaperName.Contains("x 2") -or $s.PaperName.Contains("Cut")) {
                    $bestMatch = $s
                    break
                }
                if ($bestMatch -eq $null) { $bestMatch = $s }
            } 
            else {
                if (-not ($s.PaperName.Contains("2x6") -or $s.PaperName.Contains("x2") -or $s.PaperName.Contains("x 2"))) {
                    $bestMatch = $s
                    break
                }
            }
        }
    }
    
    if ($bestMatch -eq $null) {
        foreach ($s in $sizes) {
            if (($s.PaperName.Contains("4x6") -or $s.PaperName.Contains("PC")) -and ($s.Width -ge 390 -and $s.Width -le 410)) {
                if ($is2x6 -and ($s.PaperName.Contains("2x6") -or $s.PaperName.Contains("x2") -or $s.PaperName.Contains("x 2"))) {
                    $bestMatch = $s; break
                }
                if (-not $is2x6 -and -not ($s.PaperName.Contains("2x6") -or $s.PaperName.Contains("x 2"))) {
                    $bestMatch = $s; break
                }
            }
        }
    }

    if ($bestMatch) {
        $printDoc.DefaultPageSettings.PaperSize = $bestMatch
        Write-Host ">>> AUTO-SELECTED PAPER: $($bestMatch.PaperName) ($($bestMatch.Width)x$($bestMatch.Height))"
    }
    else {
        Write-Host "!!! WARNING: No exact paper size match found. Using Driver Default."
        Write-Host "--- Available Sizes in Driver: ---"
        foreach ($s in $sizes) {
            Write-Host "   - $($s.PaperName): $($s.Width) x $($s.Height) (1/100 inch)"
        }
        Write-Host "----------------------------------"
    }
}

# --- 4. PRINT HANDLER (STRICT MODE: No Scale, No Margin) ---
$printDoc.OriginAtMargins = $false
$printDoc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

$printDoc.Add_PrintPage({
    param($sender, $e)

    $img = [System.Drawing.Image]::FromFile($imagePath)

    $rectX = $offsetX / 25.4 * 100
    $rectY = $offsetY / 25.4 * 100

    $rectW = if ($widthMm -gt 0) { $widthMm / 25.4 * 100 } else { $img.Width / $img.HorizontalResolution * 100 }
    $rectH = if ($heightMm -gt 0) { $heightMm / 25.4 * 100 } else { $img.Height / $img.VerticalResolution * 100 }

    Write-Host "Drawing Image into Rect (1/100 inch): [X=$rectX, Y=$rectY, W=$rectW, H=$rectH]"

    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    $destRect = New-Object System.Drawing.RectangleF($rectX, $rectY, $rectW, $rectH)
    $e.Graphics.DrawImage($img, $destRect)

    $img.Dispose()
})

try {
    $printDoc.Print()
    Write-Host "Success"
}
catch {
    Write-Host "Error: $_"
    exit 1
}
