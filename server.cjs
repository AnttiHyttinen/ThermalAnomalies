// Azure App Service (Windows) runs Node through iisnode, which loads the entry file with require()
// and passes a named pipe in PORT. server.mjs only listens when started directly, so start it here.
import("./server.mjs")
  .then(({ server }) => {
    server.listen(process.env.PORT || 4173);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
