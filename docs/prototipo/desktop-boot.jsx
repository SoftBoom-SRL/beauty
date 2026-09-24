// desktop-boot.jsx — mount the desktop app last (after all window globals are set)
if (!window.__yrMounted) {
  window.__yrMounted = true;
  ReactDOM.createRoot(document.getElementById('root')).render(<DesktopApp />);
}
