async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0];
  if (!file) return;

  setUploading(true);
  try {
    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`/api/leagues/${id}`, {
      method: "PUT",
      body: formData,
    });

    if (res.ok) {
      const updated = await res.json();
      setLeague((prev: any) => ({ ...prev, logo_url: updated.logo_url }));
    }
  } catch (e) {
    console.error(e);
  } finally {
    setUploading(false);
  }
}
