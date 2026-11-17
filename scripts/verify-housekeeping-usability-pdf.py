"""Read exported PDF text and compare actual room IDs with canonical saved DB proof."""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path("artifacts/hk-pdf-tools").resolve()))
from pypdf import PdfReader

directory = Path("artifacts/hk-simple")
proof = json.loads((directory / "result.json").read_text(encoding="utf-8"))
results = []
for report in proof["pdfs"]:
    reader = PdfReader(report["path"])
    text = "\n".join(page.extract_text() for page in reader.pages)
    actual = sorted(set(re.findall(r"\b4[1-3]\d{2}\b", text)))
    expected = sorted(report["roomIds"])
    assert actual == expected, f"PDF room list differs from saved DB: {report['staff']}"
    for page in reader.pages:
        assert abs(float(page.mediabox.width) - 595.28) < 2
        assert abs(float(page.mediabox.height) - 841.89) < 2
    assert report["staff"].split(" master")[0] in text
    normalized = re.sub(r"\s+", " ", text)
    totals = [int(value) for value in re.findall(r"Attendant total:\s*(\d+)\s+rooms", normalized)]
    if " master" in report["staff"]:
        assert sorted(totals) == [10, 10, 10], "Master workload totals differ from saved counts"
        assert re.search(r"Supervisor total \(SPV HK 1\):\s*100\s+rooms", normalized)
    else:
        assert totals == [10], "Attendant total differs from saved count"
        assert "Attendant signature" in text and "Supervisor signature" in text
    results.append({"staff": report["staff"], "rooms": len(actual), "pages": len(reader.pages), "a4": True, "matchesSavedDb": True, "totalsVerified": True})
assert len(results) == 4
assert results[0]["rooms"] == 100
assert all(result["rooms"] == 10 for result in results[1:])
(directory / "pdf-verification.json").write_text(json.dumps({"success": True, "reports": results}, indent=2), encoding="utf-8")
print(json.dumps({"success": True, "reports": results}))
