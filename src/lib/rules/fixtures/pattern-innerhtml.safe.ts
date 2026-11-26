export function renderUserProfileSafe(container: HTMLElement, bioText: string) {
  // SAFE: textContent encodes characters safely without parsing HTML
  container.textContent = bioText;
}
